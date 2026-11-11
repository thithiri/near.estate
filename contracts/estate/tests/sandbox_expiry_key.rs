use anyhow::{ensure, Context, Result};
use near_sdk::serde_json::{json, Value};
use near_workspaces::{
    types::{AccessKey, AccessKeyPermission, KeyType, NearToken, SecretKey},
    Account, Contract,
};
use std::path::PathBuf;

const PLOT_ID: &str = "plot-main-n-0";
const ALLOWANCE_YOCTO: u128 = 5_000_000_000_000_000_000_000_000;

fn wasm_path() -> PathBuf {
    std::env::var_os("ESTATE_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/wasm32-unknown-unknown/release/near_estate_contract.wasm")
        })
}

async fn balance(contract: &Contract, player: &Account) -> Result<u128> {
    let state: Value = contract
        .view("get_account")
        .args_json(json!({"account_id": player.id()}))
        .await?
        .json()?;
    Ok(state["balance"]
        .as_str()
        .context("missing coin balance")?
        .parse()?)
}

#[tokio::test]
async fn restricted_expiry_key_settles_once_and_cannot_play() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let contract = worker.dev_deploy(&std::fs::read(wasm_path())?).await?;
    let moderator = worker.dev_create_account().await?;
    let inspector = worker.dev_create_account().await?;
    let driver = worker.dev_create_account().await?;
    let service = worker.dev_create_account().await?;

    let init = contract
        .call("new")
        .args_json(json!({
            "admin": contract.id(), "moderator": moderator.id(), "inspector": inspector.id()
        }))
        .transact()
        .await?;
    ensure!(init.is_success(), "initialization failed: {init:?}");
    let seed = contract
        .call("seed_plot")
        .args_json(json!({"seed": {
            "road_id": "main", "side": "North", "index": 0,
            "building_type": "Retail", "variant": 1
        }}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    ensure!(seed.is_success(), "plot seed failed: {seed:?}");

    let quote: String = contract.view("registration_quote").await?.json()?;
    let registration = driver
        .call(contract.id(), "register_player")
        .args_json(json!({"body": "Hatchback", "color": "Blue"}))
        .deposit(NearToken::from_yoctonear(quote.parse()?))
        .transact()
        .await?;
    ensure!(
        registration.is_success(),
        "registration failed: {registration:?}"
    );
    let car: Value = registration.json()?;
    let car_id = car["id"].as_u64().context("missing starter car ID")?;

    let mut config: Value = contract.view("get_config").await?.json()?;
    config["version"] = json!(2);
    config["earn_cap_seconds"] = json!(60);
    config["expiry_grace_seconds"] = json!(0);
    let updated = contract
        .call("update_config")
        .args_json(json!({"config": config}))
        .transact()
        .await?;
    ensure!(updated.is_success(), "config update failed: {updated:?}");

    let parked = driver
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_id, "plot_id": PLOT_ID, "slot": 0}))
        .transact()
        .await?;
    ensure!(parked.is_success(), "parking failed: {parked:?}");
    let session: Value = parked.json()?;
    let session_id = session["id"].as_u64().context("missing session ID")?;
    let before = balance(&contract, &driver).await?;

    let secret = SecretKey::from_random(KeyType::ED25519);
    let public = secret.public_key();
    let added = service
        .batch(service.id())
        .add_key(
            public.clone(),
            AccessKey::function_call_access(
                contract.id(),
                &["settle_expired"],
                Some(NearToken::from_yoctonear(ALLOWANCE_YOCTO)),
            ),
        )
        .transact()
        .await?;
    ensure!(added.is_success(), "expiry key creation failed: {added:?}");
    let access = service.view_access_key(&public).await?;
    let AccessKeyPermission::FunctionCall(permission) = access.permission else {
        anyhow::bail!("expiry key became full access")
    };
    ensure!(permission.receiver_id == contract.id().as_str());
    ensure!(permission.method_names == ["settle_expired"]);
    ensure!(
        permission.allowance.map(|a| a.as_yoctonear()) == Some(ALLOWANCE_YOCTO),
        "expiry key allowance changed"
    );
    let restricted = Account::from_secret_key(service.id().clone(), secret, &worker);

    let forbidden = restricted
        .call(contract.id(), "park")
        .args_json(json!({"car_id": car_id, "plot_id": PLOT_ID, "slot": 1}))
        .transact()
        .await;
    ensure!(
        !matches!(forbidden, Ok(ref outcome) if outcome.is_success()),
        "expiry key invoked an unlisted method"
    );
    let early = restricted
        .call(contract.id(), "settle_expired")
        .args_json(json!({"expected_session_id": session_id}))
        .transact()
        .await?;
    ensure!(early.is_failure(), "expiry key settled before deadline");
    ensure!(balance(&contract, &driver).await? == before);

    worker.fast_forward(400).await?;
    let chain_time: u64 = contract.view("chain_time_seconds").await?.json()?;
    ensure!(
        chain_time >= session["expires_at"].as_u64().context("missing expiry")?,
        "sandbox clock did not reach expiry"
    );
    let settled = restricted
        .call(contract.id(), "settle_expired")
        .args_json(json!({"expected_session_id": session_id}))
        .transact()
        .await?;
    ensure!(
        settled.is_success(),
        "restricted settlement failed: {settled:?}"
    );
    let payout: Value = settled.json()?;
    let driver_payout: u128 = payout["driver_payout"]
        .as_str()
        .context("missing driver payout")?
        .parse()?;
    ensure!(driver_payout > 0, "expired park paid no coins");
    ensure!(balance(&contract, &driver).await? == before + driver_payout);
    let space: Value = contract
        .view("get_space_session")
        .args_json(json!({"plot_id": PLOT_ID, "slot": 0}))
        .await?
        .json()?;
    ensure!(space.is_null(), "settlement did not release the curb");

    let duplicate = restricted
        .call(contract.id(), "settle_expired")
        .args_json(json!({"expected_session_id": session_id}))
        .transact()
        .await?;
    ensure!(duplicate.is_failure(), "session settled twice");
    ensure!(balance(&contract, &driver).await? == before + driver_payout);
    Ok(())
}
