use anyhow::{ensure, Context, Result};
use near_estate_contract::ParkingRule;
use near_sdk::serde_json::{json, Value};
use near_workspaces::{Account, Worker};
use std::path::{Path, PathBuf};

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
        "key is outside private directory"
    );
    Ok(path)
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--apply"),
        "pass --apply to emit one testnet event"
    );
    let directory = PathBuf::from(std::env::var("ESTATE_DEV_KEY_DIR")?).canonicalize()?;
    let journey: Value = near_sdk::serde_json::from_slice(&std::fs::read(
        root().join("deployments/testnet-journey.json"),
    )?)?;
    ensure!(journey["network"] == "testnet", "journey is not testnet");
    let contract_id = journey["contractId"]
        .as_str()
        .context("missing journey contract")?
        .parse()?;
    let owner_id = journey["ownerId"]
        .as_str()
        .context("missing journey owner")?;
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(
        rpc_url.starts_with("https://"),
        "testnet RPC must use HTTPS"
    );
    let worker: Worker<near_workspaces::network::Testnet> =
        near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        worker.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    let owner = Account::from_file(credential(&directory, "owner")?, &worker)?;
    ensure!(owner.id().as_str() == owner_id, "owner credential mismatch");
    let result = owner
        .call(&contract_id, "set_rule")
        .args_json(json!({"plot_id":"plot-main-n-0","rule":ParkingRule::NoParking}))
        .transact()
        .await?;
    ensure!(
        result.is_success(),
        "rule event transaction failed: {result:?}"
    );
    let outcome = result
        .receipt_outcomes()
        .iter()
        .find(|outcome| {
            outcome.executor_id == contract_id
                && outcome
                    .logs
                    .iter()
                    .any(|log| log.starts_with("EVENT_JSON:"))
        })
        .context("no contract receipt emitted an event")?;
    ensure!(outcome.is_success(), "event receipt failed");
    let log = outcome
        .logs
        .iter()
        .find(|log| log.starts_with("EVENT_JSON:"))
        .context("event log is missing")?;
    let event: Value = near_sdk::serde_json::from_str(
        log.strip_prefix("EVENT_JSON:")
            .context("event prefix is missing")?,
    )?;
    ensure!(event["event"] == "rule_scheduled", "unexpected event name");
    ensure!(
        event["data"][0]["plot_id"] == "plot-main-n-0",
        "unexpected event plot"
    );
    let path = root().join("deployments/testnet-event-source.json");
    std::fs::write(
        &path,
        near_sdk::serde_json::to_vec_pretty(&json!({
            "network": "testnet",
            "contractId": contract_id,
            "ownerId": owner.id(),
            "transactionHash": result.outcome().transaction_hash.to_string(),
            "receiptId": outcome.transaction_hash.to_string(),
            "receiptBlockHash": outcome.block_hash.to_string(),
            "eventLog": log
        }))?,
    )?;
    println!("Emitted testnet event probe: {}", path.display());
    Ok(())
}
