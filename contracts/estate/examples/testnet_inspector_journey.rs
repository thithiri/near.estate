use anyhow::{bail, ensure, Context, Result};
use near_estate_contract::{AccountState, GameConfig, ParkingRule, ParkingSession, PlotView};
use near_sdk::serde_json::{json, Value};
use near_workspaces::{
    types::{AccessKey, AccessKeyPermission, AccountId, KeyType, NearToken, PublicKey, SecretKey},
    Account, Worker,
};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const PLOT_ID: &str = "plot-main-n-0";
const ALLOWANCE_YOCTO: u128 = 250_000_000_000_000_000_000_000; // 0.25 testnet NEAR

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn credential(directory: &Path, role: &str) -> Result<PathBuf> {
    let record: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(directory.join(format!("{role}.json")))?)?;
    let path = PathBuf::from(
        record["keyFile"]
            .as_str()
            .with_context(|| format!("missing {role} key file"))?,
    );
    ensure!(
        path.parent() == Some(directory),
        "{role} key is outside the private directory"
    );
    Ok(path)
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)?;
    Ok(())
}

async fn revoke_if_present(account: &Account, key: &PublicKey) -> Result<()> {
    let present = account
        .view_access_keys()
        .await?
        .iter()
        .any(|entry| &entry.public_key == key);
    if present {
        let outcome = account
            .batch(account.id())
            .delete_key(key.clone())
            .transact()
            .await?;
        ensure!(outcome.is_success(), "inspector key revocation failed");
    }
    ensure!(
        !account
            .view_access_keys()
            .await?
            .iter()
            .any(|entry| &entry.public_key == key),
        "inspector key remains on-chain"
    );
    Ok(())
}

async fn recover_previous(
    directory: &Path,
    contract: &Account,
    inspector: &Account,
    driver: &Account,
    contract_id: &AccountId,
) -> Result<()> {
    let public_path = directory.join("inspector-journey-key-public.json");
    let private_path = directory.join("inspector-journey-restricted.json");
    if public_path.exists() {
        let record: Value = near_sdk::serde_json::from_slice(&std::fs::read(&public_path)?)?;
        ensure!(
            record["contractId"] == contract_id.as_str()
                && record["accountId"] == inspector.id().as_str(),
            "previous inspector key belongs to another account or contract"
        );
        let key: PublicKey = record["publicKey"]
            .as_str()
            .context("previous inspector public key is missing")?
            .parse()?;
        ensure!(
            record["driverId"] == driver.id().as_str() && record["plotId"] == PLOT_ID,
            "previous inspector journey driver or plot differs"
        );
        let original_config: GameConfig =
            near_sdk::serde_json::from_value(record["originalConfig"].clone())?;
        if let Some(session_id) = account_state(contract, driver).await?.active_session_id {
            let session = session_at(contract)
                .await?
                .context("previous inspector session is outside the test curb")?;
            ensure!(
                session.id == session_id && session.driver == *driver.id(),
                "previous inspector session does not match the driver"
            );
            clear_test_session(contract, driver, contract_id, &session).await?;
        }
        restore_config(contract, &original_config).await?;
        revoke_if_present(inspector, &key).await?;
        std::fs::remove_file(public_path)?;
        if private_path.exists() {
            std::fs::remove_file(private_path)?;
        }
    } else {
        ensure!(
            !private_path.exists(),
            "orphan inspector private key needs manual review"
        );
    }
    Ok(())
}

async fn account_state(contract: &Account, player: &Account) -> Result<AccountState> {
    let state: Option<AccountState> = contract
        .view(contract.id(), "get_account")
        .args_json(json!({"account_id": player.id()}))
        .await?
        .json()?;
    state.context("driver account is not registered")
}

async fn session_at(contract: &Account) -> Result<Option<ParkingSession>> {
    Ok(contract
        .view(contract.id(), "get_space_session")
        .args_json(json!({"plot_id": PLOT_ID, "slot": 0}))
        .await?
        .json()?)
}

async fn wait_for_cleared_session(
    contract: &Account,
    driver: &Account,
    session_id: u64,
) -> Result<()> {
    for _ in 0..20 {
        let slot = session_at(contract).await?;
        let account = account_state(contract, driver).await?;
        if slot.is_none() && account.active_session_id.is_none() {
            return Ok(());
        }
        ensure!(
            slot.as_ref().is_none_or(|session| session.id == session_id),
            "a different car took the test curb"
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    bail!("inspection did not clear the finalized curb and driver session")
}

async fn clear_test_session(
    contract: &Account,
    driver: &Account,
    contract_id: &AccountId,
    session: &ParkingSession,
) -> Result<()> {
    let now: u64 = contract
        .view(contract.id(), "chain_time_seconds")
        .await?
        .json()?;
    let method = if now >= session.expires_at {
        "settle_expired"
    } else {
        "collect"
    };
    let outcome = driver
        .call(contract_id, method)
        .args_json(json!({"expected_session_id": session.id}))
        .transact()
        .await?;
    if !outcome.is_success() && method == "collect" {
        let expired = driver
            .call(contract_id, "settle_expired")
            .args_json(json!({"expected_session_id": session.id}))
            .transact()
            .await?;
        ensure!(expired.is_success(), "failed to clear expired test session");
    } else {
        ensure!(outcome.is_success(), "failed to clear test session");
    }
    Ok(())
}

async fn restore_config(contract: &Account, original: &GameConfig) -> Result<()> {
    let current: GameConfig = contract.view(contract.id(), "get_config").await?.json()?;
    let mut expected = near_sdk::serde_json::to_value(original)?;
    expected["version"] = json!(current.version);
    if near_sdk::serde_json::to_value(&current)? != expected {
        let mut restored = original.clone();
        restored.version = current
            .version
            .checked_add(1)
            .context("config version cannot advance for recovery")?;
        let outcome = contract
            .call(contract.id(), "update_config")
            .args_json(json!({"config": restored}))
            .transact()
            .await?;
        ensure!(outcome.is_success(), "failed to restore test config");
    }
    let final_config: GameConfig = contract.view(contract.id(), "get_config").await?.json()?;
    expected["version"] = json!(final_config.version);
    ensure!(
        near_sdk::serde_json::to_value(&final_config)? == expected,
        "test config still differs after recovery"
    );
    Ok(())
}

struct JourneyState {
    original_config: GameConfig,
    key: PublicKey,
    public_path: PathBuf,
    private_path: PathBuf,
}

async fn exercise(
    contract: &Account,
    inspector: &Account,
    driver: &Account,
    contract_id: &AccountId,
    secret: &SecretKey,
    state: &JourneyState,
) -> Result<Value> {
    let driver_state = account_state(contract, driver).await?;
    ensure!(
        driver_state.active_session_id.is_none(),
        "driver already has a parking session"
    );
    ensure!(
        session_at(contract).await?.is_none(),
        "test curb is occupied"
    );
    let plot: Option<PlotView> = contract
        .view(contract.id(), "get_plot")
        .args_json(json!({"plot_id": PLOT_ID}))
        .await?
        .json()?;
    ensure!(
        matches!(
            plot.context("test plot is missing")?.effective_rule,
            ParkingRule::NoParking
        ),
        "test plot must prohibit parking"
    );
    let car_id = *driver_state.car_ids.first().context("driver has no car")?;

    write_private(
        &state.public_path,
        &near_sdk::serde_json::to_vec_pretty(&json!({
            "contractId": contract_id,
            "accountId": inspector.id(),
            "publicKey": state.key.to_string(),
            "driverId": driver.id(),
            "plotId": PLOT_ID,
            "originalConfig": state.original_config
        }))?,
    )?;
    write_private(
        &state.private_path,
        &near_sdk::serde_json::to_vec_pretty(&json!({
            "account_id": inspector.id(),
            "private_key": secret.to_string()
        }))?,
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            std::fs::metadata(&state.private_path)?.permissions().mode() & 0o077 == 0,
            "inspector private key is readable by another user"
        );
    }
    let added = inspector
        .batch(inspector.id())
        .add_key(
            state.key.clone(),
            AccessKey::function_call_access(
                contract_id,
                &["inspect"],
                Some(NearToken::from_yoctonear(ALLOWANCE_YOCTO)),
            ),
        )
        .transact()
        .await?;
    ensure!(added.is_success(), "inspect-only key creation failed");
    let access = inspector.view_access_key(&state.key).await?;
    let AccessKeyPermission::FunctionCall(permission) = access.permission else {
        bail!("inspector journey key has full access");
    };
    ensure!(
        permission.receiver_id == contract_id.as_str()
            && permission.method_names == ["inspect"]
            && permission.allowance == Some(NearToken::from_yoctonear(ALLOWANCE_YOCTO)),
        "inspector journey key permissions do not match"
    );

    let mut tuned = state.original_config.clone();
    tuned.version += 1;
    tuned.inspector_min_age_seconds = 0;
    tuned.inspector_chance_bps = 10_000;
    let updated = contract
        .call(contract.id(), "update_config")
        .args_json(json!({"config": tuned}))
        .transact()
        .await?;
    ensure!(
        updated.is_success(),
        "test inspector settings were rejected"
    );
    let parked = driver
        .call(contract_id, "park")
        .args_json(json!({"car_id":car_id,"plot_id":PLOT_ID,"slot":0}))
        .transact()
        .await?;
    ensure!(parked.is_success(), "illegal test parking failed");
    let session: ParkingSession = parked.json()?;
    ensure!(!session.legal, "test parking unexpectedly legal");

    let output = Command::new("node")
        .arg(root().join("scripts/verify-inspector-patrol.mjs"))
        .current_dir(root())
        .env("ESTATE_CONTRACT_ID", contract_id.as_str())
        .env("INSPECTOR_ACCOUNT_ID", inspector.id().as_str())
        .env("INSPECTOR_KEY_FILE", &state.private_path)
        .output()
        .context("failed to launch inspector service journey")?;
    ensure!(
        output.status.success(),
        "inspector service journey failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).context("inspector output is not UTF-8")?;
    let report = stdout
        .lines()
        .find_map(|line| line.strip_prefix("PATROL_RESULT:"))
        .context("inspector service returned no patrol result")?;
    let patrol: Value = near_sdk::serde_json::from_str(report)
        .context("inspector service patrol result is invalid")?;
    wait_for_cleared_session(contract, driver, session.id).await?;
    Ok(json!({
        "network": "testnet",
        "contractId": contract_id,
        "inspectorId": inspector.id(),
        "driverId": driver.id(),
        "restrictedKeyPublic": state.key.to_string(),
        "allowedMethods": ["inspect"],
        "allowanceYocto": ALLOWANCE_YOCTO.to_string(),
        "sessionId": session.id,
        "patrol": patrol,
        "sessionFreed": true,
        "keyRevoked": true,
        "configRestored": true
    }))
}

async fn cleanup(
    contract: &Account,
    inspector: &Account,
    driver: &Account,
    contract_id: &AccountId,
    state: &JourneyState,
) -> Result<()> {
    if let Some(session_id) = account_state(contract, driver).await?.active_session_id {
        let session = session_at(contract)
            .await?
            .context("test session is outside the expected curb")?;
        ensure!(
            session.id == session_id && session.driver == *driver.id(),
            "test session does not match driver"
        );
        clear_test_session(contract, driver, contract_id, &session).await?;
    }
    restore_config(contract, &state.original_config).await?;
    revoke_if_present(inspector, &state.key).await?;
    if state.private_path.exists() {
        std::fs::remove_file(&state.private_path)?;
    }
    if state.public_path.exists() {
        std::fs::remove_file(&state.public_path)?;
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--apply"),
        "pass --apply to run the inspector journey"
    );
    let directory = PathBuf::from(std::env::var("ESTATE_DEV_KEY_DIR")?).canonicalize()?;
    ensure!(
        !directory.starts_with(root().canonicalize()?),
        "testnet keys must stay outside the repository"
    );
    let journey: Value = near_sdk::serde_json::from_slice(&std::fs::read(
        root().join("deployments/testnet-journey.json"),
    )?)?;
    ensure!(journey["network"] == "testnet", "journey is not testnet");
    let contract_id: AccountId = journey["contractId"]
        .as_str()
        .context("journey contract ID is missing")?
        .parse()?;
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(rpc_url.starts_with("https://"), "testnet RPC needs HTTPS");
    let worker: Worker<near_workspaces::network::Testnet> =
        near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        worker.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    let contract = Account::from_file(directory.join(format!("{contract_id}.json")), &worker)?;
    let inspector = Account::from_file(credential(&directory, "inspector")?, &worker)?;
    let driver = Account::from_file(credential(&directory, "driver")?, &worker)?;
    ensure!(
        driver.id().as_str() == journey["driverId"].as_str().unwrap_or_default(),
        "driver credential does not match journey"
    );
    let roles: (AccountId, AccountId, AccountId) =
        contract.view(contract.id(), "get_roles").await?.json()?;
    ensure!(
        roles.0 == *contract.id() && roles.2 == *inspector.id(),
        "journey contract roles do not match credentials"
    );
    recover_previous(&directory, &contract, &inspector, &driver, &contract_id).await?;
    let original_config: GameConfig = contract.view(contract.id(), "get_config").await?.json()?;
    let secret = SecretKey::from_random(KeyType::ED25519);
    let state = JourneyState {
        original_config,
        key: secret.public_key(),
        public_path: directory.join("inspector-journey-key-public.json"),
        private_path: directory.join("inspector-journey-restricted.json"),
    };
    let result = exercise(
        &contract,
        &inspector,
        &driver,
        &contract_id,
        &secret,
        &state,
    )
    .await;
    let cleanup_result = cleanup(&contract, &inspector, &driver, &contract_id, &state).await;
    cleanup_result.context("inspector journey cleanup needs attention")?;
    let mut evidence = result?;
    evidence["configVersionBefore"] = json!(state.original_config.version);
    let final_config: GameConfig = contract.view(contract.id(), "get_config").await?.json()?;
    evidence["configVersionAfter"] = json!(final_config.version);
    let path = root().join("deployments/testnet-inspector-journey.json");
    std::fs::write(&path, near_sdk::serde_json::to_vec_pretty(&evidence)?)?;
    println!("Verified inspect-only testnet patrol: {}", path.display());
    Ok(())
}
