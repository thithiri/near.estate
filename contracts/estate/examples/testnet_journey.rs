use anyhow::{ensure, Context, Result};
use near_estate_contract::{
    AccountState, BuildingType, Car, CarBody, CarColor, GameConfig, ParkingRule, ParkingSession,
    PlotSeed, PlotView, RoadId, Settlement, Side,
};
use near_sdk::json_types::U128;
use near_sdk::serde_json::{json, Value};
use near_workspaces::{types::NearToken, Account, Contract, Worker};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn credential(directory: &Path, role: &str) -> Result<PathBuf> {
    let record: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(directory.join(format!("{role}.json")))?)?;
    let key = record["keyFile"]
        .as_str()
        .with_context(|| format!("missing {role} key file"))?;
    let key = PathBuf::from(key);
    ensure!(
        key.parent() == Some(directory),
        "{role} key must be in the private directory"
    );
    Ok(key)
}

async fn account_state(contract: &Contract, account: &Account) -> Result<AccountState> {
    let state: Option<AccountState> = contract
        .view("get_account")
        .args_json(json!({"account_id": account.id()}))
        .await?
        .json()?;
    state.with_context(|| format!("{} has no game account", account.id()))
}

async fn register(
    contract: &Contract,
    account: &Account,
    body: CarBody,
    color: CarColor,
) -> Result<Car> {
    let quote: U128 = contract.view("registration_quote").await?.json()?;
    let outcome = account
        .call(contract.id(), "register_player")
        .args_json(json!({"body": body, "color": color}))
        .deposit(NearToken::from_yoctonear(quote.0))
        .transact()
        .await?;
    ensure!(outcome.is_success(), "registration failed: {outcome:?}");
    Ok(outcome.json()?)
}

async fn seed_plot(contract: &Contract, index: u8) -> Result<()> {
    let seed = PlotSeed {
        road_id: RoadId::Main,
        side: Side::North,
        index,
        building_type: if index == 0 {
            BuildingType::Retail
        } else {
            BuildingType::Cafe
        },
        variant: 1,
    };
    let outcome = contract
        .call("seed_plot")
        .args_json(json!({"seed": seed}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?;
    ensure!(outcome.is_success(), "plot seed failed: {outcome:?}");
    Ok(())
}

async fn session_at(
    contract: &Contract,
    plot_id: &str,
    slot: u8,
) -> Result<Option<ParkingSession>> {
    Ok(contract
        .view("get_space_session")
        .args_json(json!({"plot_id": plot_id, "slot": slot}))
        .await?
        .json()?)
}

async fn journey(
    worker: &Worker<near_workspaces::network::Testnet>,
    directory: &Path,
    wasm: &[u8],
) -> Result<()> {
    let admin = worker.dev_deploy(wasm).await?;
    admin.as_account().store_credentials(directory).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join(format!("{}.json", admin.id()));
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    let driver = Account::from_file(credential(directory, "driver")?, worker)?;
    let owner = Account::from_file(credential(directory, "owner")?, worker)?;
    let moderator = Account::from_file(credential(directory, "moderator")?, worker)?;
    let inspector = Account::from_file(credential(directory, "inspector")?, worker)?;
    let initialized = admin
        .call("new")
        .args_json(json!({
            "admin": admin.id(),
            "moderator": moderator.id(),
            "inspector": inspector.id()
        }))
        .transact()
        .await?;
    ensure!(
        initialized.is_success(),
        "journey contract initialization failed"
    );
    let mut config: GameConfig = admin.view("get_config").await?.json()?;
    config.version += 1;
    config.rule_delay_seconds = 0;
    config.ticket_cooldown_seconds = 0;
    config.earn_cap_seconds = 60;
    config.expiry_grace_seconds = 0;
    let updated = admin
        .call("update_config")
        .args_json(json!({"config": config}))
        .transact()
        .await?;
    ensure!(updated.is_success(), "short test timing was rejected");
    seed_plot(&admin, 0).await?;
    seed_plot(&admin, 1).await?;
    let driver_car = register(&admin, &driver, CarBody::Hatchback, CarColor::Red).await?;
    let owner_car = register(&admin, &owner, CarBody::Sedan, CarColor::Blue).await?;
    let quote: U128 = admin
        .view("plot_purchase_quote")
        .args_json(json!({"plot_id":"plot-main-n-0"}))
        .await?
        .json()?;
    let bought = owner
        .call(admin.id(), "buy_plot")
        .args_json(json!({"plot_id":"plot-main-n-0"}))
        .deposit(NearToken::from_yoctonear(quote.0))
        .transact()
        .await?;
    ensure!(
        bought.is_success(),
        "owner plot purchase failed: {bought:?}"
    );
    let owned: PlotView = admin
        .view("get_plot")
        .args_json(json!({"plot_id":"plot-main-n-0"}))
        .await?
        .json()?;
    ensure!(
        owned.plot.owner.as_ref() == Some(owner.id()),
        "plot owner mismatch"
    );

    let meter = owner
        .call(admin.id(), "set_rule")
        .args_json(json!({"plot_id":"plot-main-n-0", "rule": ParkingRule::Meter { rate_per_hour: U128(10_000_000) }}))
        .transact()
        .await?;
    ensure!(meter.is_success(), "meter rule failed: {meter:?}");
    let meter_park = driver
        .call(admin.id(), "park")
        .args_json(json!({"car_id":driver_car.id,"plot_id":"plot-main-n-0","slot":0}))
        .transact()
        .await?;
    ensure!(meter_park.is_success(), "meter park failed: {meter_park:?}");
    let meter_session: ParkingSession = meter_park.json()?;
    ensure!(meter_session.legal, "meter session was illegal");
    let owner_before = account_state(&admin, &owner).await?.balance.0;
    tokio::time::sleep(Duration::from_secs(5)).await;
    let collected = driver
        .call(admin.id(), "collect")
        .args_json(json!({"expected_session_id":meter_session.id}))
        .transact()
        .await?;
    ensure!(
        collected.is_success(),
        "meter collection failed: {collected:?}"
    );
    let meter_settlement: Settlement = collected.json()?;
    ensure!(
        meter_settlement.gross.0 > 0
            && meter_settlement.recipient_payout.0 > 0
            && meter_settlement.driver_payout.0 + meter_settlement.recipient_payout.0
                == meter_settlement.gross.0,
        "meter split did not conserve gross"
    );
    let owner_after = account_state(&admin, &owner).await?.balance.0;
    ensure!(
        owner_after - owner_before == meter_settlement.recipient_payout.0,
        "owner meter payout mismatch"
    );
    println!(
        "Meter split confirmed: gross {} subunits, owner {}",
        meter_settlement.gross.0, meter_settlement.recipient_payout.0
    );

    let prohibited = owner
        .call(admin.id(), "set_rule")
        .args_json(json!({"plot_id":"plot-main-n-0", "rule": ParkingRule::NoParking}))
        .transact()
        .await?;
    ensure!(prohibited.is_success(), "NoParking rule failed");
    let illegal_park = driver
        .call(admin.id(), "park")
        .args_json(json!({"car_id":driver_car.id,"plot_id":"plot-main-n-0","slot":0}))
        .transact()
        .await?;
    ensure!(
        illegal_park.is_success(),
        "illegal park failed: {illegal_park:?}"
    );
    let illegal_session: ParkingSession = illegal_park.json()?;
    ensure!(!illegal_session.legal, "NoParking session was legal");
    tokio::time::sleep(Duration::from_secs(5)).await;
    let ticketed = owner
        .call(admin.id(), "ticket")
        .args_json(
            json!({"plot_id":"plot-main-n-0","slot":0,"expected_session_id":illegal_session.id}),
        )
        .transact()
        .await?;
    ensure!(ticketed.is_success(), "owner ticket failed: {ticketed:?}");
    let ticket_settlement: Settlement = ticketed.json()?;
    ensure!(
        ticket_settlement.driver_payout.0 == 0
            && ticket_settlement.recipient_payout.0 > 0
            && ticket_settlement.forfeited.0 > 0,
        "ticket split was incorrect"
    );
    println!("Owner ticket confirmed: session {}", illegal_session.id);

    let driver_park = driver
        .call(admin.id(), "park")
        .args_json(json!({"car_id":driver_car.id,"plot_id":"plot-main-n-1","slot":0}))
        .transact();
    let owner_park = owner
        .call(admin.id(), "park")
        .args_json(json!({"car_id":owner_car.id,"plot_id":"plot-main-n-1","slot":0}))
        .transact();
    let (driver_result, owner_result) = tokio::join!(driver_park, owner_park);
    let driver_won = driver_result
        .as_ref()
        .is_ok_and(|result| result.is_success());
    let owner_won = owner_result
        .as_ref()
        .is_ok_and(|result| result.is_success());
    ensure!(
        driver_won != owner_won,
        "contested slot did not have exactly one winner"
    );
    let contested = session_at(&admin, "plot-main-n-1", 0)
        .await?
        .context("contested space is empty")?;
    ensure!(
        contested.driver == *if driver_won { driver.id() } else { owner.id() },
        "contested session driver mismatch"
    );
    let winner = if driver_won { &driver } else { &owner };
    let cleared = winner
        .call(admin.id(), "collect")
        .args_json(json!({"expected_session_id":contested.id}))
        .transact()
        .await?;
    ensure!(cleared.is_success(), "contested slot cleanup failed");
    ensure!(
        session_at(&admin, "plot-main-n-1", 0).await?.is_none(),
        "contested slot was not released"
    );
    println!(
        "Contested slot confirmed: one winner, session {}",
        contested.id
    );

    let expiry_park = driver
        .call(admin.id(), "park")
        .args_json(json!({"car_id":driver_car.id,"plot_id":"plot-main-n-1","slot":0}))
        .transact()
        .await?;
    ensure!(expiry_park.is_success(), "expiry park failed");
    let expiry_session: ParkingSession = expiry_park.json()?;
    tokio::time::sleep(Duration::from_secs(65)).await;
    let driver_before = account_state(&admin, &driver).await?.balance.0;
    let expired = owner
        .call(admin.id(), "settle_expired")
        .args_json(json!({"expected_session_id":expiry_session.id}))
        .transact()
        .await?;
    ensure!(
        expired.is_success(),
        "expiry settlement failed: {expired:?}"
    );
    let expiry_settlement: Settlement = expired.json()?;
    ensure!(
        expiry_settlement.driver_payout.0 > 0,
        "expiry lost driver earnings"
    );
    let driver_after = account_state(&admin, &driver).await?.balance.0;
    ensure!(
        driver_after - driver_before == expiry_settlement.driver_payout.0,
        "expiry payout mismatch"
    );
    ensure!(
        session_at(&admin, "plot-main-n-1", 0).await?.is_none(),
        "expired slot remains occupied"
    );
    println!(
        "Expiry confirmed: driver received {} subunits",
        expiry_settlement.driver_payout.0
    );

    let reconnected = Account::from_file(credential(directory, "driver")?, worker)?;
    ensure!(
        reconnected.id() == driver.id(),
        "reconnected signer changed account"
    );
    let resumed = account_state(&admin, &reconnected).await?;
    ensure!(
        resumed.active_session_id.is_none(),
        "reconnected player still has a session"
    );
    let manifest = json!({
        "network": "testnet",
        "contractId": admin.id(),
        "driverId": driver.id(),
        "ownerId": owner.id(),
        "wasmSha256": format!("{:x}", Sha256::digest(wasm)),
        "meterGross": meter_settlement.gross.0.to_string(),
        "meterOwnerPayout": meter_settlement.recipient_payout.0.to_string(),
        "ticketSessionId": illegal_session.id,
        "contestedSessionId": contested.id,
        "expiryDriverPayout": expiry_settlement.driver_payout.0.to_string(),
        "reconnected": true
    });
    let path = root().join("deployments/testnet-journey.json");
    std::fs::write(&path, near_sdk::serde_json::to_vec_pretty(&manifest)?)?;
    println!("Verified two-account testnet journey: {}", path.display());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--apply"),
        "pass --apply to run the testnet journey"
    );
    let directory = PathBuf::from(std::env::var("ESTATE_DEV_KEY_DIR")?);
    let directory = directory.canonicalize()?;
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
    journey(&worker, &directory, &wasm).await
}
