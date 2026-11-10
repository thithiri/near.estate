use anyhow::{bail, ensure, Context, Result};
use near_sdk::serde_json::{json, Value};
use near_workspaces::{
    network::{NetworkClient, NetworkInfo, Testnet},
    Account, AccountId, Worker,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

const TOWER_ID: &str = "npc-main-tower";

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn state_hash(state: &HashMap<Vec<u8>, Vec<u8>>) -> String {
    let mut entries: Vec<_> = state.iter().collect();
    entries.sort_by(|(left, _), (right, _)| left.cmp(right));
    let mut digest = Sha256::new();
    for (key, value) in entries {
        digest.update((key.len() as u64).to_le_bytes());
        digest.update(key);
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value);
    }
    format!("{:x}", digest.finalize())
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    let mut bytes = Vec::new();
    let formatter = near_sdk::serde_json::ser::PrettyFormatter::with_indent(b"  ");
    value.serialize(&mut near_sdk::serde_json::Serializer::with_formatter(
        &mut bytes, formatter,
    ))?;
    std::fs::write(&temporary, bytes)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn manifest() -> Result<(PathBuf, Value, AccountId, String)> {
    let path = root().join("deployments/testnet.json");
    let value: Value = near_sdk::serde_json::from_slice(&std::fs::read(&path)?)?;
    ensure!(value["network"] == "testnet", "manifest is not testnet");
    let id: AccountId = value["contractId"]
        .as_str()
        .context("manifest has no contract ID")?
        .parse()?;
    ensure!(id.as_str().ends_with(".testnet"), "contract is not testnet");
    let code_hash = value["wasmSha256"]
        .as_str()
        .context("manifest has no code hash")?
        .to_string();
    ensure!(code_hash.len() == 64, "manifest code hash is invalid");
    Ok((path, value, id, code_hash))
}

async fn counts_and_roles<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
    manifest: &Value,
) -> Result<()> {
    let plots: u16 = worker.view(id, "plot_count").await?.json()?;
    let sites: u8 = worker.view(id, "npc_site_count").await?.json()?;
    let roles: (AccountId, AccountId, AccountId) = worker.view(id, "get_roles").await?.json()?;
    ensure!(plots == 80 && sites == 7, "city count changed");
    ensure!(
        roles.0 == *id
            && roles.1.as_str() == manifest["moderatorId"].as_str().unwrap_or("")
            && roles.2.as_str() == manifest["inspectorId"].as_str().unwrap_or(""),
        "contract roles differ from manifest"
    );
    Ok(())
}

async fn verify_floors<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
) -> Result<Value> {
    let floors: Vec<u8> = worker
        .view(id, "get_tower_floor_availability")
        .args_json(json!({"site_id": TOWER_ID}))
        .await?
        .json()?;
    let total: u8 = worker
        .view(id, "get_tower_availability")
        .args_json(json!({"site_id": TOWER_ID}))
        .await?
        .json()?;
    ensure!(floors.len() == 4, "expected four tower floors");
    ensure!(
        floors.iter().all(|count| *count <= 8),
        "invalid floor count"
    );
    ensure!(
        floors.iter().sum::<u8>() == total,
        "floor total differs from tower total"
    );
    let open: Option<u8> = worker
        .view(id, "get_tower_open_space_on_floor")
        .args_json(json!({"site_id": TOWER_ID, "floor": 2}))
        .await?
        .json()?;
    ensure!(
        open.is_none_or(|space| (16..24).contains(&space)),
        "floor view returned another floor"
    );
    Ok(json!({"floors": floors, "total": total, "floor2FirstOpen": open}))
}

async fn verify_street_car_appearances<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
) -> Result<()> {
    for road_id in ["main", "market", "river", "central", "harbor"] {
        for side in ["North", "South"] {
            let street: Value = worker
                .view(id, "get_street_side")
                .args_json(json!({"road_id": road_id, "side": side}))
                .await?
                .json()?;
            let plots = street["plots"].as_array().context("street has no plots")?;
            ensure!(plots.len() == 8, "street side is not fully seeded");
            for plot in plots {
                let slots = plot["slots"].as_array().context("plot has no curb slots")?;
                let appearances = plot["car_appearances"]
                    .as_array()
                    .context("plot has no parked-car appearances")?;
                ensure!(
                    slots.len() == 2 && appearances.len() == 2,
                    "curb view length changed"
                );
                for slot in 0..2 {
                    if slots[slot].is_null() {
                        ensure!(
                            appearances[slot].is_null(),
                            "empty curb has a car appearance"
                        );
                    } else {
                        ensure!(
                            appearances[slot]["id"] == slots[slot]["car_id"]
                                && appearances[slot]["body"].is_string()
                                && appearances[slot]["color"].is_string(),
                            "parked car appearance does not match its session"
                        );
                    }
                }
            }
        }
    }
    Ok(())
}

async fn verify_tower_floor_batch<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
) -> Result<()> {
    let spaces: Vec<Option<Value>> = worker
        .view(id, "get_tower_floor_sessions")
        .args_json(json!({"site_id": TOWER_ID, "floor": 2}))
        .await?
        .json()?;
    ensure!(spaces.len() == 8, "tower floor batch has wrong length");
    for (offset, session) in spaces.into_iter().enumerate() {
        if let Some(session) = session {
            ensure!(
                session["facility"] == "Tower"
                    && session["location_id"] == TOWER_ID
                    && session["slot"].as_u64() == Some(16 + offset as u64),
                "tower floor batch has a misplaced session"
            );
        }
    }
    Ok(())
}

fn record_path(new_hash: &str) -> PathBuf {
    root().join(format!("deployments/testnet-code-upgrade-{new_hash}.json"))
}

async fn wait_for_code(worker: &Worker<Testnet>, id: &AccountId, expected: &str) -> Result<()> {
    for _ in 0..15 {
        if hash(&worker.view_code(id).await?) == expected {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    bail!("deployed code was not visible at finality after 30 seconds")
}

fn private_backup_path(key_file: &Path, old_hash: &str) -> Result<PathBuf> {
    let parent = key_file
        .parent()
        .context("deployment key has no parent directory")?
        .canonicalize()?;
    ensure!(
        !parent.starts_with(root().canonicalize()?),
        "backup must be outside the repository"
    );
    Ok(parent.join(format!("estate-before-code-upgrade-{old_hash}.wasm")))
}

fn save_backup(path: &Path, bytes: &[u8]) -> Result<()> {
    if path.exists() {
        ensure!(
            std::fs::read(path)? == bytes,
            "existing upgrade backup differs"
        );
        return Ok(());
    }
    std::fs::write(path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

async fn rehearse(
    worker: &Worker<Testnet>,
    id: &AccountId,
    manifest: &Value,
    old_wasm: &[u8],
    old_hash: &str,
    state_hash_before: &str,
    tower_views_before: &Value,
    new_wasm: &[u8],
) -> Result<()> {
    println!("Importing current city into a local sandbox for upgrade rehearsal...");
    let sandbox = near_workspaces::sandbox().await?;
    let copy = sandbox
        .import_contract(id, worker)
        .with_data()
        .transact()
        .await?;
    ensure!(
        hash(&sandbox.view_code(id).await?) == old_hash,
        "sandbox imported different code"
    );
    ensure!(
        state_hash(&sandbox.view_state(id).await?) == state_hash_before,
        "sandbox imported different contract state"
    );
    let outcome = copy.as_account().deploy(new_wasm).await?;
    ensure!(
        outcome.is_success(),
        "sandbox upgrade failed: {:?}",
        outcome.details
    );
    ensure!(
        state_hash(&sandbox.view_state(id).await?) == state_hash_before,
        "sandbox upgrade changed contract state"
    );
    let sandbox_views = verify_floors(&sandbox, id).await?;
    ensure!(
        sandbox_views == *tower_views_before,
        "sandbox tower views changed during code upgrade"
    );
    verify_street_car_appearances(&sandbox, id).await?;
    verify_tower_floor_batch(&sandbox, id).await?;
    let rollback = copy.as_account().deploy(old_wasm).await?;
    ensure!(
        rollback.is_success(),
        "sandbox rollback failed: {:?}",
        rollback.details
    );
    ensure!(
        hash(&sandbox.view_code(id).await?) == old_hash,
        "sandbox rollback restored different code"
    );
    ensure!(
        state_hash(&sandbox.view_state(id).await?) == state_hash_before,
        "sandbox rollback changed contract state"
    );
    ensure!(
        verify_floors(&sandbox, id).await? == *tower_views_before,
        "sandbox rollback changed tower views"
    );
    counts_and_roles(&sandbox, id, manifest).await?;
    println!(
        "Sandbox upgrade and rollback preserved every contract state key and passed old and new views."
    );
    Ok(())
}

async fn apply(
    worker: &Worker<Testnet>,
    id: &AccountId,
    manifest_path: &Path,
    mut manifest: Value,
    old_wasm: &[u8],
    old_hash: &str,
    new_wasm: &[u8],
    new_hash: &str,
    state_hash_before: &str,
    tower_views_before: &Value,
) -> Result<()> {
    let key_file = PathBuf::from(
        std::env::var("ESTATE_DEPLOY_KEY_FILE").context("ESTATE_DEPLOY_KEY_FILE is required")?,
    );
    let deployer = Account::from_file(&key_file, worker)?;
    ensure!(
        deployer.id() == id,
        "deployment key belongs to another account"
    );
    let backup_path = private_backup_path(&key_file, old_hash)?;
    save_backup(&backup_path, old_wasm)?;
    let record_path = record_path(new_hash);
    let mut record = json!({
        "network": "testnet",
        "contractId": id,
        "beforeWasmSha256": old_hash,
        "afterWasmSha256": new_hash,
        "beforeStateSha256": state_hash_before,
        "beforeTowerViews": tower_views_before,
        "status": "prepared"
    });
    if record_path.exists() {
        let existing: Value = near_sdk::serde_json::from_slice(&std::fs::read(&record_path)?)?;
        ensure!(
            existing == record,
            "existing upgrade record differs; inspect it before retrying"
        );
    }
    write_json(&record_path, &record)?;
    println!("Saved prior code outside the repository and prepared public recovery record.");

    let deployment = deployer.deploy(new_wasm).await?;
    ensure!(
        deployment.is_success(),
        "testnet deployment failed: {:?}",
        deployment.details
    );
    record["deploymentTransactionHash"] =
        json!(deployment.details.outcome().transaction_hash.to_string());
    record["deploymentBlockHash"] = json!(deployment.details.outcome().block_hash.to_string());
    write_json(&record_path, &record)?;
    let result = async {
        wait_for_code(worker, id, new_hash).await?;
        ensure!(
            verify_floors(worker, id).await? == *tower_views_before,
            "tower views changed during code upgrade"
        );
        verify_tower_floor_batch(worker, id).await?;
        verify_street_car_appearances(worker, id).await?;
        ensure!(
            state_hash(&worker.view_state(id).await?) == state_hash_before,
            "contract state changed during upgrade"
        );
        counts_and_roles(worker, id, &manifest).await?;
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        eprintln!("Post-upgrade verification failed: {error:#}; restoring prior code...");
        record["status"] = json!("recovery_required");
        record["verificationError"] = json!(error.to_string());
        write_json(&record_path, &record)?;
        let live_hash = hash(&worker.view_code(id).await?);
        if live_hash == new_hash {
            let rollback = deployer.deploy(old_wasm).await?;
            ensure!(
                rollback.is_success(),
                "rollback deployment failed: {:?}",
                rollback.details
            );
            record["rollbackTransactionHash"] =
                json!(rollback.details.outcome().transaction_hash.to_string());
            write_json(&record_path, &record)?;
            wait_for_code(worker, id, old_hash).await?;
        } else {
            ensure!(
                live_hash == old_hash,
                "live code changed to an unexpected hash during recovery"
            );
        }
        ensure!(
            state_hash(&worker.view_state(id).await?) == state_hash_before,
            "rollback did not preserve the pre-upgrade contract state"
        );
        ensure!(
            verify_floors(worker, id).await? == *tower_views_before,
            "rollback did not restore the pre-upgrade tower views"
        );
        counts_and_roles(worker, id, &manifest).await?;
        record["status"] = json!("rolled_back");
        record["afterRollbackStateSha256"] = json!(state_hash_before);
        write_json(&record_path, &record)?;
        return Err(error);
    }

    record["status"] = json!("verified");
    record["afterStateSha256"] = json!(state_hash_before);
    write_json(&record_path, &record)?;
    manifest["wasmSha256"] = json!(new_hash);
    write_json(manifest_path, &manifest)?;
    println!("Verified testnet upgrade: {}", record_path.display());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "--plan".to_string());
    ensure!(
        mode == "--plan" || mode == "--apply",
        "use --plan or --apply"
    );
    let (manifest_path, mut manifest, id, old_hash) = manifest()?;
    let new_wasm = std::fs::read(
        root().join("target/wasm32-unknown-unknown/release/near_estate_contract.wasm"),
    )?;
    ensure!(new_wasm.starts_with(b"\0asm"), "release WASM is invalid");
    let new_hash = hash(&new_wasm);
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(rpc_url.starts_with("https://"), "RPC must use HTTPS");
    let worker = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        worker.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    counts_and_roles(&worker, &id, &manifest).await?;
    let old_wasm = worker.view_code(&id).await?;
    let live_hash = hash(&old_wasm);
    ensure!(
        live_hash == old_hash || live_hash == new_hash,
        "live code differs from deployment manifest and candidate"
    );
    if old_hash == new_hash {
        ensure!(live_hash == new_hash, "manifest and live code differ");
        verify_floors(&worker, &id).await?;
        verify_tower_floor_batch(&worker, &id).await?;
        verify_street_car_appearances(&worker, &id).await?;
        println!("Current release code is already deployed and verified.");
        return Ok(());
    }
    if live_hash == new_hash {
        let record_path = record_path(&new_hash);
        let mut record: Value = near_sdk::serde_json::from_slice(&std::fs::read(&record_path)?)?;
        ensure!(
            record["contractId"] == id.as_str()
                && record["beforeWasmSha256"] == old_hash
                && record["afterWasmSha256"] == new_hash
                && (record["status"] == "prepared" || record["status"] == "verified"),
            "incomplete upgrade record does not match live code"
        );
        let expected_state = record["beforeStateSha256"]
            .as_str()
            .context("prepared upgrade has no state hash")?
            .to_string();
        ensure!(
            state_hash(&worker.view_state(&id).await?) == expected_state,
            "contract state differs from prepared upgrade; manual recovery needed"
        );
        ensure!(
            verify_floors(&worker, &id).await? == record["beforeTowerViews"],
            "tower views differ from prepared upgrade"
        );
        verify_tower_floor_batch(&worker, &id).await?;
        verify_street_car_appearances(&worker, &id).await?;
        if mode == "--apply" {
            record["status"] = json!("verified");
            record["afterStateSha256"] = json!(expected_state);
            write_json(&record_path, &record)?;
            manifest["wasmSha256"] = json!(new_hash);
            write_json(&manifest_path, &manifest)?;
            println!("Completed interrupted upgrade record.");
        } else {
            println!("New code is already live; run --apply to complete the upgrade record.");
        }
        return Ok(());
    }
    ensure!(
        live_hash == old_hash,
        "live code differs from deployment manifest"
    );
    let before = state_hash(&worker.view_state(&id).await?);
    let tower_views_before = verify_floors(&worker, &id).await?;
    println!("Current code: {old_hash}; new code: {new_hash}; state: {before}");
    rehearse(
        &worker,
        &id,
        &manifest,
        &old_wasm,
        &old_hash,
        &before,
        &tower_views_before,
        &new_wasm,
    )
    .await?;
    if mode == "--apply" {
        apply(
            &worker,
            &id,
            &manifest_path,
            manifest,
            &old_wasm,
            &old_hash,
            &new_wasm,
            &new_hash,
            &before,
            &tower_views_before,
        )
        .await?;
    }
    Ok(())
}
