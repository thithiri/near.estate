use anyhow::{ensure, Context, Result};
use near_estate_contract::{AccountState, CarBody, CarColor, Facility, ParkingSession, Settlement};
use near_sdk::{
    json_types::U128,
    serde_json::{json, Value},
};
use near_workspaces::{types::NearToken, Account, AccountId, Worker};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

const TOWER_ID: &str = "npc-main-tower";
const FLOOR: u8 = 2;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn credential(directory: &Path, role: &str) -> Result<PathBuf> {
    let record: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(directory.join(format!("{role}.json")))?)?;
    let key = PathBuf::from(
        record["keyFile"]
            .as_str()
            .context("role key file missing")?,
    );
    ensure!(
        key.parent() == Some(directory),
        "role key is outside private directory"
    );
    Ok(key)
}

async fn game_account(
    worker: &Worker<near_workspaces::network::Testnet>,
    contract: &AccountId,
    driver: &Account,
) -> Result<Option<AccountState>> {
    Ok(worker
        .view(contract, "get_account")
        .args_json(json!({"account_id": driver.id()}))
        .await?
        .json()?)
}

async fn floor_counts(
    worker: &Worker<near_workspaces::network::Testnet>,
    contract: &AccountId,
) -> Result<Vec<u8>> {
    Ok(worker
        .view(contract, "get_tower_floor_availability")
        .args_json(json!({"site_id": TOWER_ID}))
        .await?
        .json()?)
}

async fn wait_for_floor(
    worker: &Worker<near_workspaces::network::Testnet>,
    contract: &AccountId,
    expected: u8,
) -> Result<Vec<u8>> {
    for _ in 0..12 {
        let counts = floor_counts(worker, contract).await?;
        if counts.get(usize::from(FLOOR)) == Some(&expected) {
            return Ok(counts);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    anyhow::bail!("floor count did not reach {expected} at finality")
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--apply"),
        "pass --apply for the disposable testnet journey"
    );
    let directory = PathBuf::from(std::env::var("ESTATE_DEV_KEY_DIR")?).canonicalize()?;
    ensure!(
        !directory.starts_with(root().canonicalize()?),
        "keys must be outside repository"
    );
    let manifest: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(root().join("deployments/testnet.json"))?)?;
    let contract: AccountId = manifest["contractId"]
        .as_str()
        .context("contract ID missing")?
        .parse()?;
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    let worker = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        worker.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    let driver = Account::from_file(credential(&directory, "driver")?, &worker)?;
    let mut account = game_account(&worker, &contract, &driver).await?;
    if account.is_none() {
        let quote: U128 = worker.view(&contract, "registration_quote").await?.json()?;
        let registration = driver
            .call(&contract, "register_player")
            .args_json(json!({"body": CarBody::Hatchback, "color": CarColor::Red}))
            .deposit(NearToken::from_yoctonear(quote.0))
            .transact()
            .await?;
        ensure!(
            registration.is_success(),
            "driver registration failed: {:?}",
            registration
        );
        for _ in 0..12 {
            account = game_account(&worker, &contract, &driver).await?;
            if account.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
    let account = account.context("driver registration was not finalized")?;
    if let Some(session_id) = account.active_session_id {
        let session: ParkingSession = worker
            .view(&contract, "get_session")
            .args_json(json!({"session_id": session_id}))
            .await?
            .json()?;
        ensure!(
            session.driver == *driver.id()
                && session.facility == Facility::Tower
                && session.location_id == TOWER_ID,
            "driver has an unrelated earning session"
        );
        let chain_now: u64 = worker.view(&contract, "chain_time_seconds").await?.json()?;
        let method = if chain_now >= session.expires_at {
            "settle_expired"
        } else {
            "collect"
        };
        let settled = driver
            .call(&contract, method)
            .args_json(json!({"expected_session_id": session_id}))
            .transact()
            .await?;
        ensure!(
            settled.is_success(),
            "prior tower session could not be collected: {:?}",
            settled
        );
    }
    let before = wait_for_floor(&worker, &contract, 8).await?;
    ensure!(before == [8, 8, 8, 8], "tower is not empty before journey");
    let space: Option<u8> = worker
        .view(&contract, "get_tower_open_space_on_floor")
        .args_json(json!({"site_id": TOWER_ID, "floor": FLOOR}))
        .await?
        .json()?;
    ensure!(space == Some(16), "floor 3 did not return its first space");
    let parked = driver
        .call(&contract, "park_tower")
        .args_json(json!({"car_id": account.starter_car_id, "site_id": TOWER_ID, "space": space}))
        .transact()
        .await?;
    ensure!(parked.is_success(), "tower park failed: {:?}", parked);
    let park_hash = parked.outcome().transaction_hash.to_string();
    let session: ParkingSession = parked.json()?;
    ensure!(
        session.facility == Facility::Tower && session.slot == 16,
        "parked on wrong floor"
    );
    let occupied = wait_for_floor(&worker, &contract, 7).await?;
    ensure!(occupied == [8, 8, 7, 8], "another tower floor changed");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let collected = driver
        .call(&contract, "collect")
        .args_json(json!({"expected_session_id": session.id}))
        .transact()
        .await?;
    ensure!(
        collected.is_success(),
        "tower collect failed: {:?}",
        collected
    );
    let collect_hash = collected.outcome().transaction_hash.to_string();
    let payout: Settlement = collected.json()?;
    ensure!(
        payout.gross.0 > 0 && payout.driver_payout.0 == payout.gross.0,
        "tower earnings did not pay the driver"
    );
    let after = wait_for_floor(&worker, &contract, 8).await?;
    ensure!(after == before, "tower floor did not reopen");
    ensure!(
        game_account(&worker, &contract, &driver)
            .await?
            .context("driver missing")?
            .active_session_id
            .is_none(),
        "driver still has an active parking session"
    );
    let path = root().join("deployments/testnet-tower-floor-journey.json");
    let record = json!({
        "network": "testnet",
        "contractId": contract,
        "driverId": driver.id(),
        "floor": FLOOR + 1,
        "space": session.slot,
        "sessionId": session.id,
        "beforeFloors": before,
        "occupiedFloors": occupied,
        "afterFloors": after,
        "gross": payout.gross,
        "driverPayout": payout.driver_payout,
        "parkTransactionHash": park_hash,
        "collectTransactionHash": collect_hash
    });
    let mut bytes = Vec::new();
    let formatter = near_sdk::serde_json::ser::PrettyFormatter::with_indent(b"  ");
    record.serialize(&mut near_sdk::serde_json::Serializer::with_formatter(
        &mut bytes, formatter,
    ))?;
    std::fs::write(&path, bytes)?;
    println!("Verified live floor-3 park and collect: {}", path.display());
    Ok(())
}
