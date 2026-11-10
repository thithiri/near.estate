use anyhow::{ensure, Result};
use near_estate_contract::{
    BuildingType, CarBody, CarColor, MediaDecisionStatus, MediaIdentity, MediaKind, MediaProposal,
    PlotSeed, PlotView, RoadId, Side,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_workspaces::{
    types::{AccessKey, AccessKeyPermission, KeyType, NearToken, SecretKey},
    Account, AccountId, Contract, Worker,
};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PLOT_ID: &str = "plot-main-n-0";
const ALLOWANCE_YOCTO: u128 = 500_000_000_000_000_000_000_000;
const METHODS: [&str; 6] = [
    "approve_appearance",
    "reject_appearance",
    "revoke_appearance",
    "approve_media",
    "reject_media",
    "revoke_media",
];

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn recovery_directory() -> Result<PathBuf> {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let path = std::env::temp_dir().join(format!(
        "near-estate-moderation-{}-{stamp}",
        std::process::id()
    ));
    std::fs::create_dir(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path)
}

async fn save_recovery_account(account: &Account, directory: &Path) -> Result<()> {
    account.store_credentials(directory).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            directory.join(format!("{}.json", account.id())),
            std::fs::Permissions::from_mode(0o600),
        )?;
    }
    Ok(())
}

fn save_pending_secret(directory: &Path, id: &AccountId, secret: &SecretKey) -> Result<()> {
    let path = directory.join(format!("{id}.json"));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(&near_sdk::serde_json::to_vec_pretty(&json!({
        "account_id": id,
        "public_key": secret.public_key(),
        "secret_key": secret,
    }))?)?;
    file.sync_all()?;
    Ok(())
}

async fn sponsored_account(
    sponsor: &Account,
    label: &str,
    balance: NearToken,
    directory: &Path,
) -> Result<Account> {
    let id: AccountId = format!("{label}.{}", sponsor.id()).parse()?;
    let secret = SecretKey::from_random(KeyType::ED25519);
    // Persist the only recovery key before the account-creation transaction.
    save_pending_secret(directory, &id, &secret)?;
    let account = sponsor
        .create_subaccount(label)
        .initial_balance(balance)
        .keys(secret)
        .transact()
        .await?
        .into_result()?;
    save_recovery_account(&account, directory).await?;
    Ok(account)
}

async fn journey_accounts(
    worker: &Worker<near_workspaces::network::Testnet>,
    wasm: &[u8],
    directory: &Path,
) -> Result<(Contract, Account, Account, Account, &'static str)> {
    if let Ok(key_path) = std::env::var("ESTATE_TESTNET_SPONSOR_KEY_FILE") {
        let key_path = PathBuf::from(key_path).canonicalize()?;
        ensure!(
            !key_path.starts_with(root().canonicalize()?),
            "sponsor key must be outside the repository"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                std::fs::metadata(&key_path)?.permissions().mode() & 0o077 == 0,
                "sponsor key file must be private"
            );
        }
        let sponsor = Account::from_file(&key_path, worker)?;
        ensure!(
            sponsor.id().as_str().ends_with(".testnet"),
            "sponsor must be a testnet account"
        );
        let deployed: near_sdk::serde_json::Value = near_sdk::serde_json::from_slice(
            &std::fs::read(root().join("deployments/testnet.json"))?,
        )?;
        ensure!(
            ["contractId", "moderatorId", "inspectorId"]
                .iter()
                .all(|field| deployed[field].as_str() != Some(sponsor.id().as_str())),
            "sponsor must not be a live game role account"
        );
        let access = sponsor
            .view_access_key(&sponsor.secret_key().public_key())
            .await?;
        ensure!(
            matches!(access.permission, AccessKeyPermission::FullAccess),
            "sponsor key must have full access"
        );
        ensure!(
            sponsor.view_account().await?.balance.as_yoctonear()
                >= NearToken::from_near(8).as_yoctonear(),
            "sponsor needs at least 8 testnet NEAR"
        );
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let suffix = format!("{:012x}", stamp & 0xffffffffffff);
        ensure!(
            sponsor.id().as_str().len() + suffix.len() + 2 <= 64,
            "sponsor account ID is too long for disposable subaccounts"
        );
        let contract_account = sponsored_account(
            &sponsor,
            &format!("c{suffix}"),
            NearToken::from_near(3),
            directory,
        )
        .await?;
        let contract = contract_account.deploy(wasm).await?.into_result()?;
        let moderator = sponsored_account(
            &sponsor,
            &format!("m{suffix}"),
            NearToken::from_near(1),
            directory,
        )
        .await?;
        let owner = sponsored_account(
            &sponsor,
            &format!("o{suffix}"),
            NearToken::from_near(3),
            directory,
        )
        .await?;
        let inspector = sponsored_account(
            &sponsor,
            &format!("i{suffix}"),
            NearToken::from_millinear(100),
            directory,
        )
        .await?;
        return Ok((contract, moderator, owner, inspector, "operator-sponsored"));
    }

    let contract = worker.dev_deploy(wasm).await?;
    save_recovery_account(contract.as_account(), directory).await?;
    let moderator = worker.dev_create_account().await?;
    save_recovery_account(&moderator, directory).await?;
    let owner = worker.dev_create_account().await?;
    save_recovery_account(&owner, directory).await?;
    let inspector = worker.dev_create_account().await?;
    save_recovery_account(&inspector, directory).await?;
    Ok((contract, moderator, owner, inspector, "public-faucet"))
}

async fn plot(contract: &Contract) -> Result<PlotView> {
    Ok(contract
        .view("get_plot")
        .args_json(json!({"plot_id": PLOT_ID}))
        .await?
        .json()?)
}

async fn wait_for_media(
    contract: &Contract,
    expected_active: bool,
    revision: u64,
) -> Result<PlotView> {
    for _ in 0..20 {
        let view = plot(contract).await?;
        if view.plot.logo.revision == revision
            && view.plot.logo.pending.is_none()
            && view.plot.logo.active.is_some() == expected_active
        {
            return Ok(view);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    anyhow::bail!("finalized media state did not converge")
}

async fn journey(
    worker: &Worker<near_workspaces::network::Testnet>,
    wasm: &[u8],
    directory: &Path,
) -> Result<&'static str> {
    let (contract, moderator, owner, inspector, funding_mode) =
        journey_accounts(worker, wasm, directory).await?;
    let initialized = contract
        .call("new")
        .args_json(json!({
            "admin": contract.id(),
            "moderator": moderator.id(),
            "inspector": inspector.id()
        }))
        .transact()
        .await?;
    ensure!(initialized.is_success(), "contract initialization failed");
    let seeded = contract
        .call("seed_plot")
        .args_json(json!({
            "seed": PlotSeed {
                road_id: RoadId::Main,
                side: Side::North,
                index: 0,
                building_type: BuildingType::Retail,
                variant: 1,
            }
        }))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    ensure!(seeded.is_success(), "plot seed failed");
    let registration_quote: U128 = contract.view("registration_quote").await?.json()?;
    let registered = owner
        .call(contract.id(), "register_player")
        .args_json(json!({"body": CarBody::Hatchback, "color": CarColor::Red}))
        .deposit(NearToken::from_yoctonear(registration_quote.0))
        .transact()
        .await?;
    ensure!(registered.is_success(), "owner registration failed");
    let purchase_quote: U128 = contract
        .view("plot_purchase_quote")
        .args_json(json!({"plot_id": PLOT_ID}))
        .await?
        .json()?;
    let bought = owner
        .call(contract.id(), "buy_plot")
        .args_json(json!({"plot_id": PLOT_ID}))
        .deposit(NearToken::from_yoctonear(purchase_quote.0))
        .transact()
        .await?;
    ensure!(bought.is_success(), "plot purchase failed");
    let before = plot(&contract).await?;
    ensure!(
        before.plot.owner.as_ref() == Some(owner.id()),
        "owner mismatch"
    );
    let content = MediaIdentity {
        asset_hash: format!("{:x}", Sha256::digest(b"near-estate-moderation-probe")),
        link: Some("https://example.com/test-brand".to_string()),
    };
    let proposed = owner
        .call(contract.id(), "propose_media")
        .args_json(json!({
            "plot_id": PLOT_ID,
            "kind": MediaKind::Logo,
            "expected_media_revision": before.plot.logo.revision,
            "expected_layout_revision": before.plot.building.layout_revision,
            "content": content,
        }))
        .transact()
        .await?;
    ensure!(proposed.is_success(), "owner logo proposal failed");
    let proposal: MediaProposal = proposed.json()?;
    let restricted_secret = SecretKey::from_random(KeyType::ED25519);
    let public_key = restricted_secret.public_key();
    let added = moderator
        .batch(moderator.id())
        .add_key(
            public_key.clone(),
            AccessKey::function_call_access(
                contract.id(),
                &METHODS,
                Some(NearToken::from_yoctonear(ALLOWANCE_YOCTO)),
            ),
        )
        .transact()
        .await?;
    ensure!(
        added.is_success(),
        "restricted moderation key creation failed"
    );
    std::fs::write(
        directory.join("restricted-key-public.json"),
        near_sdk::serde_json::to_vec_pretty(&json!({
            "moderatorId": moderator.id(),
            "contractId": contract.id(),
            "publicKey": public_key.to_string(),
        }))?,
    )?;
    let restricted = Account::from_secret_key(moderator.id().clone(), restricted_secret, worker);
    let approved = restricted
        .call(contract.id(), "approve_media")
        .args_json(json!({"plot_id": PLOT_ID, "kind": MediaKind::Logo, "expected": proposal}))
        .transact()
        .await?;
    ensure!(approved.is_success(), "restricted logo approval failed");
    let active = wait_for_media(&contract, true, proposal.revision).await?;
    ensure!(
        active.plot.logo.active.as_ref().map(|entry| &entry.content) == Some(&content),
        "approved logo differs from the exact proposal"
    );
    ensure!(
        active
            .plot
            .logo
            .last_decision
            .as_ref()
            .map(|entry| entry.status)
            == Some(MediaDecisionStatus::Approved),
        "approval decision missing"
    );
    let access = moderator.view_access_key(&public_key).await?;
    let AccessKeyPermission::FunctionCall(permission) = access.permission else {
        anyhow::bail!("runtime key became full-access")
    };
    ensure!(
        permission.receiver_id == contract.id().as_str()
            && permission
                .method_names
                .iter()
                .map(String::as_str)
                .collect::<Vec<_>>()
                == METHODS
            && permission
                .allowance
                .is_some_and(|remaining| remaining.as_yoctonear() > 0
                    && remaining.as_yoctonear() < ALLOWANCE_YOCTO),
        "moderation key scope or spent allowance mismatch"
    );
    let revoked = restricted
        .call(contract.id(), "revoke_media")
        .args_json(json!({
            "plot_id": PLOT_ID,
            "kind": MediaKind::Logo,
            "expected_media_revision": proposal.revision,
            "expected_content": content,
            "reason": "Disposable moderation journey complete"
        }))
        .transact()
        .await?;
    ensure!(revoked.is_success(), "restricted logo revocation failed");
    let cleared = wait_for_media(&contract, false, proposal.revision + 1).await?;
    ensure!(
        cleared
            .plot
            .logo
            .last_decision
            .as_ref()
            .map(|entry| entry.status)
            == Some(MediaDecisionStatus::Revoked),
        "revocation decision missing"
    );
    let removed = moderator
        .batch(moderator.id())
        .delete_key(public_key.clone())
        .transact()
        .await?;
    ensure!(removed.is_success(), "restricted key cleanup failed");
    ensure!(
        !moderator
            .view_access_keys()
            .await?
            .iter()
            .any(|entry| entry.public_key == public_key),
        "restricted key remains on-chain"
    );
    let evidence = json!({
        "network": "testnet",
        "fundingMode": funding_mode,
        "contractId": contract.id(),
        "ownerId": owner.id(),
        "moderatorId": moderator.id(),
        "plotId": PLOT_ID,
        "logoHash": content.asset_hash,
        "proposalRevision": proposal.revision,
        "approvedTransaction": approved.outcome().transaction_hash.to_string(),
        "revokedTransaction": revoked.outcome().transaction_hash.to_string(),
        "restrictedKeyPublic": public_key.to_string(),
        "restrictedKeyRemoved": true,
        "finalMediaRevision": cleared.plot.logo.revision,
        "finalMediaActive": cleared.plot.logo.active.is_some(),
        "wasmSha256": format!("{:x}", Sha256::digest(wasm)),
        "imageBytes": "synthetic hash only; API upload and visual review are separate gates"
    });
    let path = root().join("deployments/testnet-moderation-journey.json");
    std::fs::write(&path, near_sdk::serde_json::to_vec_pretty(&evidence)?)?;
    println!(
        "Verified restricted moderator testnet journey: {}",
        path.display()
    );
    Ok(funding_mode)
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--apply"),
        "pass --apply to create a disposable testnet moderation journey"
    );
    let wasm = std::fs::read(
        root().join("target/wasm32-unknown-unknown/release/near_estate_contract.wasm"),
    )?;
    ensure!(wasm.starts_with(b"\0asm"), "release WASM is missing");
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
    let directory = recovery_directory()?;
    let result = journey(&worker, &wasm, &directory).await;
    match &result {
        Ok("public-faucet") => std::fs::remove_dir_all(&directory)?,
        Ok("operator-sponsored") => eprintln!(
            "Sponsor-funded account keys remain at {} for balance recovery",
            directory.display()
        ),
        Ok(_) => anyhow::bail!("unknown moderation journey funding mode"),
        Err(_) if directory.read_dir()?.next().is_none() => std::fs::remove_dir(&directory)?,
        Err(_) => eprintln!(
            "Disposable testnet recovery credentials remain outside the repository at {}",
            directory.display()
        ),
    }
    result.map(|_| ())
}
