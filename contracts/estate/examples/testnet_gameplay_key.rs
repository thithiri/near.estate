use anyhow::{ensure, Context, Result};
use near_estate_contract::ParkingRule;
use near_sdk::serde_json::{json, Value};
use near_workspaces::{
    types::{AccessKey, AccessKeyPermission, AccountId, Gas, KeyType, NearToken, SecretKey},
    Account, Worker,
};
use std::path::{Path, PathBuf};

const GAMEPLAY_METHODS: [&str; 8] = [
    "park",
    "park_tower",
    "collect",
    "settle_expired",
    "ticket",
    "repair",
    "emergency_repair",
    "set_rule",
];
const ALLOWANCE_YOCTO: u128 = 62_000_000_000_000_000_000_000; // 0.062 testnet NEAR
const TEST_PLOT: &str = "plot-main-n-0";

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

fn failed_text(
    outcome: near_workspaces::result::Result<near_workspaces::result::ExecutionFinalResult>,
) -> Result<String> {
    match outcome {
        Ok(result) => {
            ensure!(
                !result.is_success(),
                "restricted transaction unexpectedly succeeded"
            );
            Ok(format!("{result:?}"))
        }
        Err(error) => Ok(format!("{error:?}")),
    }
}

async fn revoke_if_present(owner: &Account, key: &near_workspaces::types::PublicKey) -> Result<()> {
    let present = owner
        .view_access_keys()
        .await?
        .iter()
        .any(|entry| &entry.public_key == key);
    if present {
        let removed = owner
            .batch(owner.id())
            .delete_key(key.clone())
            .transact()
            .await?;
        ensure!(
            removed.is_success(),
            "gameplay key revocation failed: {removed:?}"
        );
    }
    let still_present = owner
        .view_access_keys()
        .await?
        .iter()
        .any(|entry| &entry.public_key == key);
    ensure!(
        !still_present,
        "gameplay key remains on-chain after revocation"
    );
    Ok(())
}

async fn exercise(
    worker: &Worker<near_workspaces::network::Testnet>,
    owner: &Account,
    contract_id: &AccountId,
    key: &near_workspaces::types::PublicKey,
    secret: SecretKey,
) -> Result<Value> {
    let added = owner
        .batch(owner.id())
        .add_key(
            key.clone(),
            AccessKey::function_call_access(
                contract_id,
                &GAMEPLAY_METHODS,
                Some(NearToken::from_yoctonear(ALLOWANCE_YOCTO)),
            ),
        )
        .transact()
        .await?;
    ensure!(
        added.is_success(),
        "gameplay key creation failed: {added:?}"
    );

    let initial = owner.view_access_key(key).await?;
    let AccessKeyPermission::FunctionCall(permission) = initial.permission else {
        anyhow::bail!("gameplay key unexpectedly has full access");
    };
    ensure!(
        permission.receiver_id == contract_id.as_str(),
        "key receiver mismatch"
    );
    ensure!(
        permission.method_names == GAMEPLAY_METHODS.map(str::to_string),
        "key method allowlist mismatch"
    );
    ensure!(
        permission.allowance == Some(NearToken::from_yoctonear(ALLOWANCE_YOCTO)),
        "key allowance mismatch"
    );

    let restricted = Account::from_secret_key(owner.id().clone(), secret, worker);
    let method_error = failed_text(
        restricted
            .call(contract_id, "buy_car")
            .args_json(json!({"body":"Hatchback","color":"Red"}))
            .gas(Gas::from_tgas(60))
            .transact()
            .await,
    )?;
    ensure!(
        method_error.contains("MethodNameMismatch"),
        "buy_car was rejected for an unexpected reason: {method_error}"
    );

    let deposit_error = failed_text(
        restricted
            .call(contract_id, "set_rule")
            .args_json(json!({"plot_id":TEST_PLOT,"rule":ParkingRule::NoParking}))
            .gas(Gas::from_tgas(60))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await,
    )?;
    ensure!(
        deposit_error.contains("DepositWithFunctionCall"),
        "attached deposit was rejected for an unexpected reason: {deposit_error}"
    );

    let receiver_error = failed_text(
        restricted
            .call(owner.id(), "get_config")
            .gas(Gas::from_tgas(60))
            .transact()
            .await,
    )?;
    ensure!(
        receiver_error.contains("ReceiverMismatch"),
        "wrong receiver was rejected for an unexpected reason: {receiver_error}"
    );

    let mut successful_calls = 0u8;
    let mut allowance_exhausted = false;
    for _ in 0..12 {
        let outcome = restricted
            .call(contract_id, "set_rule")
            .args_json(json!({"plot_id":TEST_PLOT,"rule":ParkingRule::NoParking}))
            .gas(Gas::from_tgas(60))
            .transact()
            .await;
        match outcome {
            Ok(result) if result.is_success() => successful_calls += 1,
            other => {
                let error = failed_text(other)?;
                ensure!(
                    error.contains("NotEnoughAllowance"),
                    "allowed call failed for an unexpected reason: {error}"
                );
                allowance_exhausted = true;
                break;
            }
        }
    }
    ensure!(
        successful_calls > 0,
        "gameplay key never made an allowed call"
    );
    ensure!(allowance_exhausted, "small test allowance did not run out");
    let final_key = owner.view_access_key(key).await?;
    let AccessKeyPermission::FunctionCall(final_permission) = final_key.permission else {
        anyhow::bail!("gameplay key permission changed unexpectedly");
    };
    let remaining = final_permission
        .allowance
        .context("allowance became unlimited")?;
    ensure!(
        remaining.as_yoctonear() < ALLOWANCE_YOCTO,
        "allowed calls did not consume allowance"
    );
    Ok(json!({
        "network": "testnet",
        "contractId": contract_id,
        "ownerId": owner.id(),
        "keyPublic": key.to_string(),
        "allowanceYocto": ALLOWANCE_YOCTO.to_string(),
        "remainingYoctoBeforeRevoke": remaining.as_yoctonear().to_string(),
        "allowedCalls": successful_calls,
        "methodBlocked": true,
        "depositBlocked": true,
        "wrongReceiverBlocked": true,
        "allowanceExhausted": true,
        "revoked": true
    }))
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--apply"),
        "pass --apply to run the testnet key check"
    );
    let directory = PathBuf::from(std::env::var("ESTATE_DEV_KEY_DIR")?).canonicalize()?;
    let journey: Value = near_sdk::serde_json::from_slice(&std::fs::read(
        root().join("deployments/testnet-journey.json"),
    )?)?;
    ensure!(
        journey["network"] == "testnet",
        "journey manifest is not testnet"
    );
    let contract_id: AccountId = journey["contractId"]
        .as_str()
        .context("missing journey contract ID")?
        .parse()?;
    let owner_id = journey["ownerId"].as_str().context("missing owner ID")?;
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(
        rpc_url.starts_with("https://"),
        "testnet RPC must use HTTPS"
    );
    let worker = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        worker.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    let owner = Account::from_file(credential(&directory, "owner")?, &worker)?;
    ensure!(owner.id().as_str() == owner_id, "owner credential mismatch");

    let recovery_path = directory.join("gameplay-key-test-public.json");
    if recovery_path.exists() {
        let previous: Value = near_sdk::serde_json::from_slice(&std::fs::read(&recovery_path)?)?;
        ensure!(
            previous["ownerId"] == owner_id && previous["contractId"] == contract_id.as_str(),
            "previous key belongs to another test account or contract"
        );
        let prior_key = previous["publicKey"]
            .as_str()
            .context("previous key record has no public key")?
            .parse()?;
        revoke_if_present(&owner, &prior_key).await?;
        std::fs::remove_file(&recovery_path)?;
    }

    let secret = SecretKey::from_random(KeyType::ED25519);
    let key = secret.public_key();
    std::fs::write(
        &recovery_path,
        near_sdk::serde_json::to_vec_pretty(&json!({
            "ownerId": owner_id,
            "contractId": contract_id,
            "publicKey": key.to_string()
        }))?,
    )?;
    let result = exercise(&worker, &owner, &contract_id, &key, secret).await;
    let cleanup = revoke_if_present(&owner, &key).await;
    if cleanup.is_ok() {
        std::fs::remove_file(&recovery_path)?;
    }
    cleanup.context("failed to remove the test gameplay key")?;
    let evidence = result?;
    let path = root().join("deployments/testnet-gameplay-key.json");
    std::fs::write(&path, near_sdk::serde_json::to_vec_pretty(&evidence)?)?;
    println!(
        "Verified gameplay key permissions, exhaustion and revocation: {}",
        path.display()
    );
    Ok(())
}
