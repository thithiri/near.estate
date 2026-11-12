use anyhow::{ensure, Context, Result};
use near_estate_city_migration::{CityRootV2, DeedMove, LegacyRoot};
use near_estate_contract::{BuildingType, PlotSeedV2, RoadId, Side};
use near_sdk::{
    borsh,
    serde_json::{json, Value},
};
use near_workspaces::{
    network::{NetworkClient, NetworkInfo},
    types::Gas,
    Account, AccountId, Worker,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// Records paths under the home directory as `~/...` so a public release record never names the operator account.
fn home_relative(path: &Path) -> String {
    match std::env::var_os("HOME").map(PathBuf::from) {
        Some(home) => match path.strip_prefix(&home) {
            Ok(rest) => format!("~/{}", rest.to_string_lossy()),
            Err(_) => path.to_string_lossy().into_owned(),
        },
        None => path.to_string_lossy().into_owned(),
    }
}

fn expand_home(value: &str) -> PathBuf {
    match (value.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(home)) => PathBuf::from(home).join(rest),
        _ => PathBuf::from(value),
    }
}

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

fn read_json(path: &Path) -> Result<Value> {
    Ok(near_sdk::serde_json::from_slice(&fs::read(path)?)?)
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    let mut bytes = Vec::new();
    let formatter = near_sdk::serde_json::ser::PrettyFormatter::with_indent(b"  ");
    value.serialize(&mut near_sdk::serde_json::Serializer::with_formatter(
        &mut bytes, formatter,
    ))?;
    bytes.push(b'\n');
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value[field]
        .as_str()
        .with_context(|| format!("missing {field}"))
}

fn packet_check(args: &[String]) -> Result<Value> {
    let output = Command::new("node")
        .arg(root().join("scripts/check-variable-city-release-packet.mjs"))
        .args(args)
        .arg("--live")
        .current_dir(root())
        .output()
        .context("run read-only city packet check")?;
    ensure!(
        output.status.success(),
        "city packet check failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(near_sdk::serde_json::from_slice(&output.stdout)?)
}

fn seeds(city: &Value) -> Result<Vec<PlotSeedV2>> {
    city["plots"]
        .as_array()
        .context("version-2 plots array missing")?
        .iter()
        .map(|plot| {
            Ok(PlotSeedV2 {
                road_id: near_sdk::serde_json::from_value::<RoadId>(plot["roadId"].clone())?,
                side: near_sdk::serde_json::from_value::<Side>(plot["side"].clone())?,
                index: plot["index"].as_u64().context("plot index missing")? as u8,
                frontage_units: plot["frontageUnits"]
                    .as_u64()
                    .context("plot width missing")? as u8,
                building_type: near_sdk::serde_json::from_value::<BuildingType>(
                    plot["initialType"].clone(),
                )?,
                variant: plot["initialVariant"]
                    .as_u64()
                    .context("building variant missing")? as u8,
            })
        })
        .collect()
}

fn backup_old_code(key_file: &Path, old_hash: &str, bytes: &[u8]) -> Result<PathBuf> {
    let parent = key_file
        .parent()
        .context("deployment key has no parent directory")?
        .canonicalize()?;
    ensure!(
        !parent.starts_with(root().canonicalize()?),
        "deployment key and old-code backup must be outside the repository"
    );
    let directory = parent.join("estate-city-release-backups");
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{old_hash}.wasm"));
    if path.exists() {
        ensure!(
            hash(&fs::read(&path)?) == old_hash,
            "old-code backup differs"
        );
        return Ok(path);
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    ensure!(
        hash(&fs::read(&path)?) == old_hash,
        "old-code backup failed"
    );
    Ok(path)
}

async fn check_chain<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
    expected_code: &str,
    expected_state: &str,
) -> Result<HashMap<Vec<u8>, Vec<u8>>> {
    let mut last_code = String::new();
    let mut last_state = String::new();
    for _ in 0..20 {
        let code = worker.view_code(id).await?;
        let state = worker.view_state(id).await?;
        last_code = hash(&code);
        last_state = state_hash(&state);
        if last_code == expected_code && last_state == expected_state {
            return Ok(state);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    anyhow::bail!(
        "live code/storage differs: code {last_code} (expected {expected_code}), storage {last_state} (expected {expected_state})"
    )
}

async fn deploy_checked<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    deployer: &Account,
    worker: &Worker<N>,
    id: &AccountId,
    wasm: &[u8],
) -> Result<String> {
    let result = deployer.deploy(wasm).await?;
    ensure!(result.is_success(), "code deployment failed");
    let transaction_hash = result.details.outcome().transaction_hash.to_string();
    let expected = hash(wasm);
    let mut matched = false;
    for _ in 0..20 {
        if hash(&worker.view_code(id).await?) == expected {
            matched = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    ensure!(matched, "deployed code hash differs");
    Ok(transaction_hash)
}

fn converted_recovery_state(record: &Value, live_code: &str, live_state: &str) -> Result<bool> {
    let old_code = string(record, "beforeWasmSha256")?;
    let forward_code = string(record, "afterWasmSha256")?;
    let reverse_code = string(record, "reverseWasmSha256")?;
    let old_state = string(record, "beforeStateSha256")?;
    let converted_state = string(record, "convertedStateSha256")?;
    ensure!(
        [old_code, forward_code, reverse_code].contains(&live_code),
        "unexpected live code during recovery"
    );
    if live_state == converted_state {
        ensure!(
            live_code != old_code,
            "old code cannot read converted storage"
        );
        return Ok(true);
    }
    ensure!(
        live_state == old_state,
        "live storage differs from both exact recovery states"
    );
    ensure!(
        !record["migrationTransactionHash"].is_string()
            || record["reverseTransactionHash"].is_string()
            || live_code == reverse_code,
        "recorded migration succeeded but converted storage is absent"
    );
    Ok(false)
}

async fn recover<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    deployer: &Account,
    worker: &Worker<N>,
    id: &AccountId,
    manifest_path: &Path,
    record_path: &Path,
    record: &mut Value,
    old_wasm: &[u8],
    reverse_wasm: &[u8],
    completion_status: &str,
) -> Result<()> {
    let old_hash = string(record, "beforeWasmSha256")?.to_string();
    let forward_hash = string(record, "afterWasmSha256")?.to_string();
    let reverse_hash = string(record, "reverseWasmSha256")?.to_string();
    let old_state_hash = string(record, "beforeStateSha256")?.to_string();
    let converted_hash = string(record, "convertedStateSha256")?.to_string();
    ensure!(
        hash(old_wasm) == old_hash,
        "private old-code backup differs"
    );
    ensure!(hash(reverse_wasm) == reverse_hash, "reverse WASM differs");
    let manifest_before = read_json(manifest_path)?;
    ensure!(
        manifest_before["wasmSha256"] == old_hash || manifest_before["wasmSha256"] == forward_hash,
        "deployment manifest changed before recovery"
    );
    let mut live_code = String::new();
    let mut live_state = String::new();
    let require_converted = record["migrationTransactionHash"].is_string();
    for _ in 0..20 {
        live_code = hash(&worker.view_code(id).await?);
        live_state = state_hash(&worker.view_state(id).await?);
        if live_state == converted_hash
            || (live_state == old_state_hash && (!require_converted || live_code == reverse_hash))
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let converted = converted_recovery_state(record, &live_code, &live_state)?;
    if converted {
        if live_code != reverse_hash {
            let transaction_hash = deploy_checked(deployer, worker, id, reverse_wasm).await?;
            record["reverseDeployTransactionHash"] = json!(transaction_hash);
            write_json(record_path, record)?;
        }
        let reversed = deployer
            .call(id, "reverse_city")
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        ensure!(
            reversed.is_success(),
            "reverse migration failed: {reversed:?}"
        );
        record["reverseTransactionHash"] = json!(reversed.outcome().transaction_hash.to_string());
        write_json(record_path, record)?;
    }
    if converted {
        check_chain(worker, id, &reverse_hash, &old_state_hash).await?;
    } else {
        ensure!(
            state_hash(&worker.view_state(id).await?) == old_state_hash,
            "legacy storage changed during recovery"
        );
    }
    if hash(&worker.view_code(id).await?) != old_hash {
        let transaction_hash = deploy_checked(deployer, worker, id, old_wasm).await?;
        record["oldCodeRestoreTransactionHash"] = json!(transaction_hash);
        write_json(record_path, record)?;
    }
    check_chain(worker, id, &old_hash, &old_state_hash).await?;
    let count: u16 = worker.view(id, "plot_count").await?.json()?;
    ensure!(count == 80, "restored legacy code cannot read city");
    let mut manifest = read_json(manifest_path)?;
    ensure!(
        manifest["wasmSha256"] == old_hash || manifest["wasmSha256"] == forward_hash,
        "deployment manifest changed during recovery"
    );
    manifest["wasmSha256"] = json!(old_hash);
    manifest["citySeedVersion"] = json!(1);
    manifest["configVersion"] = json!(1);
    manifest["plotCount"] = json!(80);
    write_json(manifest_path, &manifest)?;
    record["status"] = json!(completion_status);
    write_json(record_path, record)?;
    Ok(())
}

async fn apply(args: &[String]) -> Result<()> {
    ensure!(
        args.len() == 4,
        "use --apply <preflight> <backup-dir> <runtime.wasm> <reverse.wasm>"
    );
    let packet = packet_check(&args[..3])?;
    ensure!(
        packet["migrationReady"] == true,
        "release packet is not ready"
    );
    let report_path = root().join(&args[0]);
    let report_bytes = fs::read(&report_path)?;
    let report: Value = near_sdk::serde_json::from_slice(&report_bytes)?;
    ensure!(
        hash(&report_bytes) == string(&packet, "reportSha256")?,
        "preflight report changed after packet check"
    );
    ensure!(
        report["migrationReady"] == true,
        "preflight report is not ready"
    );
    let inventory_bytes = fs::read(root().join(string(&report, "inventoryFile")?))?;
    let inventory: Value = near_sdk::serde_json::from_slice(&inventory_bytes)?;
    let release_bytes = fs::read(root().join(string(&report, "releaseEvidenceFile")?))?;
    let release: Value = near_sdk::serde_json::from_slice(&release_bytes)?;
    let target_seed_bytes = fs::read(root().join("contracts/estate/seed-v2.json"))?;
    let target_seed: Value = near_sdk::serde_json::from_slice(&target_seed_bytes)?;
    let move_plan_bytes = fs::read(root().join("contracts/estate/migration-v1-to-v2-draft.json"))?;
    let move_plan: Value = near_sdk::serde_json::from_slice(&move_plan_bytes)?;
    ensure!(
        hash(&inventory_bytes) == string(&report, "inventorySha256")?,
        "inventory changed after packet check"
    );
    ensure!(
        hash(&release_bytes) == string(&report, "releaseEvidenceSha256")?,
        "release evidence changed after packet check"
    );
    ensure!(
        hash(&target_seed_bytes) == string(&report, "targetSeedSha256")?,
        "target seed changed after packet check"
    );
    ensure!(
        hash(&move_plan_bytes) == string(&report, "movePlanSha256")?,
        "deed move map changed after packet check"
    );
    let rehearsal = &release["rehearsal"];
    let id: AccountId = string(&report, "contractId")?.parse()?;
    let old_hash = string(&inventory, "codeSha256")?.to_string();
    let old_state_hash = string(&inventory, "stateSha256")?.to_string();
    let runtime_wasm = fs::read(root().join(&args[2]))?;
    let reverse_wasm = fs::read(root().join(&args[3]))?;
    ensure!(
        hash(&runtime_wasm) == string(&release, "releaseWasmSha256")?,
        "release WASM differs"
    );
    ensure!(
        hash(&reverse_wasm) == string(rehearsal, "reverseWasmSha256")?,
        "reverse WASM differs from rehearsal"
    );
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
    let before_state = check_chain(&worker, &id, &old_hash, &old_state_hash).await?;
    let root_state: LegacyRoot = borsh::from_slice(
        before_state
            .get(b"STATE".as_slice())
            .context("legacy root missing")?,
    )?;
    ensure!(root_state.paused, "city must be paused before migration");
    ensure!(root_state.admin == id, "legacy admin differs");
    let key_file = PathBuf::from(
        std::env::var("ESTATE_DEPLOY_KEY_FILE").context("ESTATE_DEPLOY_KEY_FILE is required")?,
    )
    .canonicalize()?;
    let deployer = Account::from_file(&key_file, &worker)?;
    ensure!(
        deployer.id() == &id,
        "deployment key belongs to another account"
    );
    let old_wasm = worker.view_code(&id).await?;
    backup_old_code(&key_file, &old_hash, &old_wasm)?;
    let target_seeds = seeds(&target_seed)?;
    let moves: Vec<DeedMove> = near_sdk::serde_json::from_value(move_plan["moves"].clone())?;
    let record_path = root().join(format!(
        "deployments/variable-city-release-{}.json",
        &hash(&runtime_wasm)[..16]
    ));
    ensure!(
        !record_path.exists(),
        "release record already exists; inspect or recover it before retrying"
    );
    let mut record = json!({
        "contractId": id,
        "preflightFile": args[0],
        "preflightSha256": hash(&report_bytes),
        "beforeWasmSha256": old_hash,
        "afterWasmSha256": hash(&runtime_wasm),
        "reverseWasmSha256": hash(&reverse_wasm),
        "beforeStateSha256": old_state_hash,
        "convertedStateSha256": rehearsal["convertedSandboxStateSha256"],
        "frozenBlock": inventory["finalBlock"],
        "status": "prepared"
    });
    write_json(&record_path, &record)?;
    let result = async {
        let transaction_hash = deploy_checked(&deployer, &worker, &id, &runtime_wasm).await?;
        record["deployTransactionHash"] = json!(transaction_hash);
        record["status"] = json!("code_deployed");
        write_json(&record_path, &record)?;
        check_chain(&worker, &id, &hash(&runtime_wasm), &old_state_hash).await?;
        let migration = deployer
            .call(&id, "migrate_city")
            .args_json(json!({
                "seeds": target_seeds,
                "moves": moves,
                "expected_config_version": rehearsal["oldConfigVersion"],
                "expected_source_plot_hash": rehearsal["sourcePlotHash"],
                "expected_target_seed_hash": rehearsal["targetSeedHash"],
            }))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        ensure!(
            migration.is_success(),
            "live migration failed: {migration:?}"
        );
        record["migrationTransactionHash"] =
            json!(migration.outcome().transaction_hash.to_string());
        record["status"] = json!("migration_submitted");
        write_json(&record_path, &record)?;
        let converted = check_chain(
            &worker,
            &id,
            &hash(&runtime_wasm),
            string(rehearsal, "convertedSandboxStateSha256")?,
        )
        .await?;
        let converted_root: CityRootV2 = borsh::from_slice(
            converted
                .get(b"STATE".as_slice())
                .context("converted root missing")?,
        )?;
        ensure!(
            converted_root.paused
                && converted_root.city_version == 2
                && converted_root.plot_count == 100
                && converted_root.npc_site_count == 7,
            "converted root has wrong counts or pause state"
        );
        let version: u8 = worker.view(&id, "city_version").await?.json()?;
        let count: u16 = worker.view(&id, "plot_count").await?.json()?;
        ensure!(
            version == 2 && count == 100,
            "runtime cannot read converted city"
        );
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        record["status"] = json!("recovery_required");
        record["verificationError"] = json!(error.to_string());
        write_json(&record_path, &record)?;
        recover(
            &deployer,
            &worker,
            &id,
            &root().join("deployments/testnet.json"),
            &record_path,
            &mut record,
            &old_wasm,
            &reverse_wasm,
            "rolled_back",
        )
        .await
        .context("automatic recovery failed; release record remains recovery_required")?;
        return Err(error);
    }
    let manifest_path = root().join("deployments/testnet.json");
    let mut manifest = read_json(&manifest_path)?;
    if manifest["wasmSha256"] != old_hash {
        record["status"] = json!("manifest_update_required");
        write_json(&record_path, &record)?;
        anyhow::bail!("deployment manifest changed during migration; city remains paused");
    }
    manifest["wasmSha256"] = json!(hash(&runtime_wasm));
    manifest["citySeedVersion"] = target_seed["version"].clone();
    manifest["configVersion"] = rehearsal["newConfigVersion"].clone();
    manifest["plotCount"] = json!(100);
    if let Err(error) = write_json(&manifest_path, &manifest) {
        record["status"] = json!("manifest_update_required");
        write_json(&record_path, &record)?;
        return Err(error.into());
    }
    record["status"] = json!("verified_paused");
    write_json(&record_path, &record)?;
    println!("Verified paused version-2 city: {}", record_path.display());
    Ok(())
}

async fn rollback(record_path: &Path, reverse_path: &Path, service_data_dir: &Path) -> Result<()> {
    let mut record = read_json(record_path)?;
    ensure!(
        [
            "prepared",
            "code_deployed",
            "migration_submitted",
            "manifest_update_required",
            "verified_paused",
            "recovery_required",
            "manual_rollback_started"
        ]
        .iter()
        .any(|status| record["status"] == *status),
        "release record is not in a reversible state"
    );
    let report_bytes = fs::read(root().join(string(&record, "preflightFile")?))?;
    ensure!(
        hash(&report_bytes) == string(&record, "preflightSha256")?,
        "release preflight changed before rollback"
    );
    let report: Value = near_sdk::serde_json::from_slice(&report_bytes)?;
    ensure!(
        report["backupEvidence"].is_object(),
        "release has no verified service backup"
    );
    let service_data_dir = service_data_dir.canonicalize()?;
    ensure!(
        service_data_dir.join("estate.sqlite").is_file()
            && service_data_dir.join("assets").is_dir(),
        "service data directory is missing SQLite or artwork"
    );
    if record["status"] == "manual_rollback_started" {
        ensure!(
            PathBuf::from(string(&record, "serviceDataDir")?).canonicalize()? == service_data_dir,
            "rollback retry must use the recorded service data directory"
        );
    }
    if !record["serviceDbPath"].is_null() {
        ensure!(
            service_data_dir.join("estate.sqlite").canonicalize()?
                == expand_home(string(&record, "serviceDbPath")?).canonicalize()?,
            "rollback service data differs from the release cutover database"
        );
    }
    record["serviceDataDir"] = json!(service_data_dir.to_string_lossy());
    record["status"] = json!("manual_rollback_started");
    write_json(record_path, &record)?;
    let id: AccountId = string(&record, "contractId")?.parse()?;
    let key_file = PathBuf::from(
        std::env::var("ESTATE_DEPLOY_KEY_FILE").context("ESTATE_DEPLOY_KEY_FILE is required")?,
    )
    .canonicalize()?;
    let old_hash = string(&record, "beforeWasmSha256")?.to_string();
    let old_path = key_file
        .parent()
        .context("deployment key has no parent")?
        .join("estate-city-release-backups")
        .join(format!("{old_hash}.wasm"));
    let old_wasm = fs::read(old_path)?;
    let reverse_wasm = fs::read(root().join(reverse_path))?;
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
    let deployer = Account::from_file(&key_file, &worker)?;
    ensure!(
        deployer.id() == &id,
        "deployment key belongs to another account"
    );
    recover(
        &deployer,
        &worker,
        &id,
        &root().join("deployments/testnet.json"),
        record_path,
        &mut record,
        &old_wasm,
        &reverse_wasm,
        "chain_rolled_back_service_pending",
    )
    .await?;
    println!(
        "Restored paused legacy chain; restore service backup before finalizing: {}",
        record_path.display()
    );
    Ok(())
}

async fn rollback_finalize(args: &[String]) -> Result<()> {
    ensure!(
        args.len() == 2,
        "use --rollback-finalize <release-record> <verified-backup-dir>"
    );
    let record_path = root().join(&args[0]);
    let mut record = read_json(&record_path)?;
    ensure!(
        record["status"] == "chain_rolled_back_service_pending",
        "chain rollback has not completed"
    );
    let output = Command::new("node")
        .arg(root().join("scripts/verify-variable-city-service-restore.mjs"))
        .arg(&record_path)
        .arg(root().join(&args[1]))
        .arg(string(&record, "serviceDataDir")?)
        .current_dir(root())
        .output()
        .context("verify restored service backup")?;
    ensure!(
        output.status.success(),
        "service restore check failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let verified: Value = near_sdk::serde_json::from_slice(&output.stdout)?;
    ensure!(
        verified["verified"] == true && verified["contractId"] == record["contractId"],
        "service restore result is incomplete"
    );
    let id: AccountId = string(&record, "contractId")?.parse()?;
    let manifest = read_json(&root().join("deployments/testnet.json"))?;
    ensure!(
        manifest["contractId"] == id.as_str()
            && manifest["wasmSha256"] == record["beforeWasmSha256"],
        "legacy deployment manifest differs"
    );
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
    let state = check_chain(
        &worker,
        &id,
        string(&record, "beforeWasmSha256")?,
        string(&record, "beforeStateSha256")?,
    )
    .await?;
    let legacy: LegacyRoot = borsh::from_slice(
        state
            .get(b"STATE".as_slice())
            .context("legacy root missing")?,
    )?;
    ensure!(
        legacy.paused && legacy.plot_count == 80 && legacy.admin == id,
        "restored legacy city differs"
    );
    record["serviceRestoreVerification"] = verified;
    record["status"] = json!("rolled_back");
    write_json(&record_path, &record)?;
    println!("Verified complete city rollback: {}", record_path.display());
    Ok(())
}

fn service_cutover_check(
    record: &Value,
    db_path: &Path,
    at_ms: u64,
    allow_reused_source: bool,
) -> Result<Value> {
    ensure!(db_path.is_file(), "release service database is missing");
    ensure!(
        at_ms > 0,
        "cutover time must be a Unix millisecond timestamp"
    );
    let report_bytes = fs::read(root().join(string(record, "preflightFile")?))?;
    ensure!(
        hash(&report_bytes) == string(record, "preflightSha256")?,
        "preflight report changed after release"
    );
    let report: Value = near_sdk::serde_json::from_slice(&report_bytes)?;
    ensure!(
        report["contractId"] == record["contractId"],
        "release report contract differs"
    );
    let map_path = root().join("contracts/estate/migration-v1-to-v2-draft.json");
    let map_bytes = fs::read(&map_path)?;
    ensure!(
        hash(&map_bytes) == string(&report, "movePlanSha256")?,
        "deed move map changed after release"
    );
    let map: Value = near_sdk::serde_json::from_slice(&map_bytes)?;
    ensure!(map["status"] == "reviewed", "deed move map is not reviewed");
    let mut command = Command::new("node");
    command
        .arg("--import")
        .arg("tsx")
        .arg(root().join("scripts/snapshot-deed-history.ts"))
        .arg("--db")
        .arg(db_path)
        .arg("--contract")
        .arg(string(record, "contractId")?)
        .arg("--height")
        .arg(
            record["frozenBlock"]["height"]
                .as_u64()
                .context("frozen block height missing")?
                .to_string(),
        )
        .arg("--at-ms")
        .arg(at_ms.to_string())
        .arg("--verify")
        .current_dir(root());
    if allow_reused_source {
        command.arg("--allow-reused-source");
    }
    let output = command.output().context("verify service deed cutover")?;
    ensure!(
        output.status.success(),
        "service deed cutover check failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let verified: Value = near_sdk::serde_json::from_slice(&output.stdout)?;
    ensure!(
        verified["verified"] == true
            && verified["sourceReadOnly"] == true
            && verified["allowReusedSourceActivity"]
                .as_bool()
                .unwrap_or(false)
                == allow_reused_source
            && verified["links"].as_u64()
                == map["moves"].as_array().map(|moves| moves.len() as u64),
        "service deed cutover result is incomplete"
    );
    Ok(verified)
}

#[derive(Clone, Copy)]
enum ReopenMode {
    Plan,
    Apply,
    Verify,
}

async fn reopen_city(args: &[String], mode: ReopenMode) -> Result<()> {
    ensure!(
        args.len() == 3,
        "use --resume-plan|--resume-apply|--resume-verify <release-record> <service-db> <cutover-at-ms>"
    );
    let record_path = root().join(&args[0]);
    let mut record = read_json(&record_path)?;
    let at_ms = args[2].parse::<u64>().context("invalid cutover time")?;
    let status = string(&record, "status")?;
    match mode {
        ReopenMode::Plan | ReopenMode::Apply => {
            ensure!(
                status == "verified_paused"
                    || (status == "resume_started" && record["resumeTransactionHash"].is_null()),
                "release is not verified and paused, or has a submitted resume transaction"
            )
        }
        ReopenMode::Verify => ensure!(
            ["resume_started", "resume_submitted", "active"].contains(&status),
            "release has no resume attempt to verify"
        ),
    }
    ensure!(
        record["migrationTransactionHash"].is_string(),
        "release migration transaction is missing"
    );
    if !record["cutoverAtMs"].is_null() {
        ensure!(
            record["cutoverAtMs"].as_u64() == Some(at_ms),
            "cutover time differs from the recorded resume attempt"
        );
    }
    let id: AccountId = string(&record, "contractId")?.parse()?;
    let service = service_cutover_check(
        &record,
        &root().join(&args[1]),
        at_ms,
        matches!(mode, ReopenMode::Verify),
    )?;
    let manifest = read_json(&root().join("deployments/testnet.json"))?;
    ensure!(
        manifest["contractId"] == id.as_str()
            && manifest["wasmSha256"] == record["afterWasmSha256"],
        "deployment manifest differs from released city"
    );
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
    let released_hash = string(&record, "afterWasmSha256")?.to_string();
    let state = match mode {
        ReopenMode::Plan | ReopenMode::Apply => {
            check_chain(
                &worker,
                &id,
                &released_hash,
                string(&record, "convertedStateSha256")?,
            )
            .await?
        }
        ReopenMode::Verify => {
            ensure!(
                hash(&worker.view_code(&id).await?) == released_hash,
                "live code differs from released city"
            );
            worker.view_state(&id).await?
        }
    };
    let city: CityRootV2 = borsh::from_slice(
        state
            .get(b"STATE".as_slice())
            .context("version-2 root missing")?,
    )?;
    ensure!(
        city.admin == id
            && city.city_version == 2
            && city.plot_count == 100
            && city.npc_site_count == 7,
        "released city root has wrong admin, version or counts"
    );
    if matches!(mode, ReopenMode::Plan | ReopenMode::Apply) {
        ensure!(city.paused, "city was already reopened");
    } else {
        ensure!(
            !city.paused,
            "city is still paused; inspect the resume transaction"
        );
    }
    let version: u8 = worker.view(&id, "city_version").await?.json()?;
    let count: u16 = worker.view(&id, "plot_count").await?.json()?;
    ensure!(
        version == 2 && count == 100,
        "runtime views differ from released city"
    );
    if matches!(mode, ReopenMode::Plan) {
        println!(
            "{}",
            near_sdk::serde_json::to_string_pretty(&json!({
                "readyToResume": true,
                "contractId": id,
                "releaseRecord": args[0],
                "serviceVerification": service,
                "cityPaused": true,
                "cityVersion": version,
                "plotCount": count
            }))?
        );
        return Ok(());
    }
    if matches!(mode, ReopenMode::Apply) {
        let key_file = PathBuf::from(
            std::env::var("ESTATE_DEPLOY_KEY_FILE")
                .context("ESTATE_DEPLOY_KEY_FILE is required")?,
        )
        .canonicalize()?;
        let deployer = Account::from_file(&key_file, &worker)?;
        ensure!(
            deployer.id() == &id,
            "deployment key belongs to another account"
        );
        record["status"] = json!("resume_started");
        record["cutoverAtMs"] = json!(at_ms);
        record["serviceDbPath"] = json!(home_relative(&root().join(&args[1]).canonicalize()?));
        record["serviceVerification"] = service;
        write_json(&record_path, &record)?;
        let result = deployer
            .call(&id, "set_paused")
            .args_json(json!({"paused": false}))
            .gas(Gas::from_tgas(20))
            .transact()
            .await?;
        ensure!(result.is_success(), "city unpause failed: {result:?}");
        record["resumeTransactionHash"] = json!(result.outcome().transaction_hash.to_string());
        record["status"] = json!("resume_submitted");
        write_json(&record_path, &record)?;
    }
    let resumed_state = worker.view_state(&id).await?;
    let resumed: CityRootV2 = borsh::from_slice(
        resumed_state
            .get(b"STATE".as_slice())
            .context("resumed root missing")?,
    )?;
    ensure!(
        !resumed.paused && resumed.city_version == 2 && resumed.plot_count == 100,
        "city did not reopen with the expected version and plot count"
    );
    ensure!(
        hash(&worker.view_code(&id).await?) == released_hash,
        "runtime code changed during resume"
    );
    if record["status"] != "active" {
        let mut normalized_root = resumed;
        normalized_root.paused = true;
        let mut normalized_state = resumed_state;
        normalized_state.insert(b"STATE".to_vec(), borsh::to_vec(&normalized_root)?);
        ensure!(
            state_hash(&normalized_state) == string(&record, "convertedStateSha256")?,
            "storage changed beyond the pause flag during resume"
        );
    }
    record["status"] = json!("active");
    if record["reopenedAtMs"].is_null() {
        record["reopenedAtMs"] = json!(u64::try_from(
            SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
        )?);
    }
    write_json(&record_path, &record)?;
    println!("Verified active version-2 city: {}", record_path.display());
    Ok(())
}

async fn sandbox_drill(args: &[String]) -> Result<()> {
    ensure!(
        args.len() == 4,
        "use --sandbox-drill <rehearsal.json> <runtime.wasm> <reverse.wasm> <deployments/output.json>"
    );
    ensure!(
        args[3].starts_with("deployments/") && args[3].ends_with(".json"),
        "sandbox drill output must be a deployments JSON file"
    );
    let rehearsal = read_json(&root().join(&args[0]))?;
    let runtime_wasm = fs::read(root().join(&args[1]))?;
    let reverse_wasm = fs::read(root().join(&args[2]))?;
    ensure!(
        hash(&runtime_wasm) == string(&rehearsal, "migrationWasmSha256")?,
        "runtime WASM differs from rehearsal"
    );
    ensure!(
        hash(&reverse_wasm) == string(&rehearsal, "reverseWasmSha256")?,
        "reverse WASM differs from rehearsal"
    );
    let id: AccountId = string(&rehearsal, "contractId")?.parse()?;
    let manifest = read_json(&root().join("deployments/testnet.json"))?;
    ensure!(
        manifest["contractId"] == id.as_str(),
        "contract differs from manifest"
    );
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(
        rpc_url.starts_with("https://"),
        "testnet RPC must use HTTPS"
    );
    let testnet = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        testnet.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    let old_wasm = testnet.view_code(&id).await?;
    ensure!(
        hash(&old_wasm) == string(&rehearsal, "liveCodeSha256")?,
        "live code differs from rehearsal"
    );
    let live_state = testnet.view_state(&id).await?;
    ensure!(
        state_hash(&live_state) == string(&rehearsal, "liveStateSha256")?,
        "live storage differs from rehearsal"
    );
    let sandbox = near_workspaces::sandbox().await?;
    let imported = sandbox
        .import_contract(&id, &testnet)
        .with_data()
        .transact()
        .await?;
    ensure!(
        sandbox.view_state(&id).await? == live_state,
        "sandbox import differs from live storage"
    );
    let paused = imported
        .as_account()
        .call(&id, "set_paused")
        .args_json(json!({"paused": true}))
        .transact()
        .await?;
    ensure!(paused.is_success(), "sandbox pause failed");
    let paused_state = sandbox.view_state(&id).await?;
    let paused_hash = state_hash(&paused_state);
    ensure!(
        paused_hash == string(&rehearsal, "pausedSandboxStateSha256")?,
        "sandbox pause differs from rehearsal"
    );
    let paused_root: LegacyRoot = borsh::from_slice(
        paused_state
            .get(b"STATE".as_slice())
            .context("paused root missing")?,
    )?;
    ensure!(paused_root.paused, "sandbox root is not paused");
    let target_seed = read_json(&root().join("contracts/estate/seed-v2.json"))?;
    let target_seeds = seeds(&target_seed)?;
    let move_plan = read_json(&root().join("contracts/estate/migration-v1-to-v2-draft.json"))?;
    let moves: Vec<DeedMove> = near_sdk::serde_json::from_value(move_plan["moves"].clone())?;
    let temporary = std::env::temp_dir().join(format!(
        "estate-city-runner-drill-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    ));
    fs::create_dir(&temporary)?;
    let manifest_path = temporary.join("testnet.json");
    write_json(&manifest_path, &manifest)?;
    let mut record = json!({
        "beforeWasmSha256": hash(&old_wasm),
        "afterWasmSha256": hash(&runtime_wasm),
        "reverseWasmSha256": hash(&reverse_wasm),
        "beforeStateSha256": paused_hash,
        "convertedStateSha256": rehearsal["convertedSandboxStateSha256"],
        "status": "prepared"
    });
    let record_path = temporary.join("forward-record.json");
    write_json(&record_path, &record)?;
    let forward_deploy =
        deploy_checked(imported.as_account(), &sandbox, &id, &runtime_wasm).await?;
    check_chain(&sandbox, &id, &hash(&runtime_wasm), &paused_hash).await?;
    let migration = imported
        .as_account()
        .call(&id, "migrate_city")
        .args_json(json!({
            "seeds": target_seeds,
            "moves": moves,
            "expected_config_version": rehearsal["oldConfigVersion"],
            "expected_source_plot_hash": rehearsal["sourcePlotHash"],
            "expected_target_seed_hash": rehearsal["targetSeedHash"],
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(
        migration.is_success(),
        "sandbox migration failed: {migration:?}"
    );
    record["migrationTransactionHash"] = json!(migration.outcome().transaction_hash.to_string());
    record["status"] = json!("verified_paused");
    write_json(&record_path, &record)?;
    let converted = check_chain(
        &sandbox,
        &id,
        &hash(&runtime_wasm),
        string(&rehearsal, "convertedSandboxStateSha256")?,
    )
    .await?;
    let converted_root: CityRootV2 = borsh::from_slice(
        converted
            .get(b"STATE".as_slice())
            .context("converted root missing")?,
    )?;
    ensure!(
        converted_root.paused
            && converted_root.city_version == 2
            && converted_root.plot_count == 100,
        "sandbox converted root differs"
    );
    let unpause = imported
        .as_account()
        .call(&id, "set_paused")
        .args_json(json!({"paused": false}))
        .gas(Gas::from_tgas(20))
        .transact()
        .await?;
    ensure!(unpause.is_success(), "sandbox unpause failed: {unpause:?}");
    let unpaused_state = sandbox.view_state(&id).await?;
    let mut unpaused_root: CityRootV2 = borsh::from_slice(
        unpaused_state
            .get(b"STATE".as_slice())
            .context("unpaused root missing")?,
    )?;
    ensure!(
        !unpaused_root.paused && unpaused_root.city_version == 2 && unpaused_root.plot_count == 100,
        "sandbox city did not reopen"
    );
    let is_paused: bool = sandbox.view(&id, "is_paused").await?.json()?;
    ensure!(!is_paused, "sandbox runtime still reports paused");
    unpaused_root.paused = true;
    let mut normalized_state = unpaused_state;
    normalized_state.insert(b"STATE".to_vec(), borsh::to_vec(&unpaused_root)?);
    ensure!(
        state_hash(&normalized_state) == state_hash(&converted),
        "sandbox unpause changed storage beyond the pause flag"
    );
    let repause = imported
        .as_account()
        .call(&id, "set_paused")
        .args_json(json!({"paused": true}))
        .gas(Gas::from_tgas(20))
        .transact()
        .await?;
    ensure!(repause.is_success(), "sandbox re-pause failed: {repause:?}");
    check_chain(
        &sandbox,
        &id,
        &hash(&runtime_wasm),
        string(&rehearsal, "convertedSandboxStateSha256")?,
    )
    .await?;
    recover(
        imported.as_account(),
        &sandbox,
        &id,
        &manifest_path,
        &record_path,
        &mut record,
        &old_wasm,
        &reverse_wasm,
        "rolled_back",
    )
    .await?;
    ensure!(
        record["status"] == "rolled_back",
        "sandbox reverse did not finish"
    );
    ensure!(
        sandbox.view_state(&id).await? == paused_state,
        "sandbox reverse storage differs"
    );
    let interrupted_reverse_record_path = temporary.join("interrupted-reverse-record.json");
    let mut interrupted_reverse_record = json!({
        "beforeWasmSha256": hash(&old_wasm),
        "afterWasmSha256": hash(&runtime_wasm),
        "reverseWasmSha256": hash(&reverse_wasm),
        "beforeStateSha256": paused_hash,
        "convertedStateSha256": rehearsal["convertedSandboxStateSha256"],
        "migrationTransactionHash": migration.outcome().transaction_hash.to_string(),
        "status": "manual_rollback_started"
    });
    write_json(
        &interrupted_reverse_record_path,
        &interrupted_reverse_record,
    )?;
    let interrupted_reverse_deploy =
        deploy_checked(imported.as_account(), &sandbox, &id, &reverse_wasm).await?;
    check_chain(&sandbox, &id, &hash(&reverse_wasm), &paused_hash).await?;
    recover(
        imported.as_account(),
        &sandbox,
        &id,
        &manifest_path,
        &interrupted_reverse_record_path,
        &mut interrupted_reverse_record,
        &old_wasm,
        &reverse_wasm,
        "chain_rolled_back_service_pending",
    )
    .await?;
    ensure!(
        interrupted_reverse_record["status"] == "chain_rolled_back_service_pending"
            && sandbox.view_state(&id).await? == paused_state
            && hash(&sandbox.view_code(&id).await?) == hash(&old_wasm),
        "interrupted reverse did not resume to the exact paused legacy city"
    );
    let code_only_record_path = temporary.join("code-only-record.json");
    let mut code_only_record = json!({
        "beforeWasmSha256": hash(&old_wasm),
        "afterWasmSha256": hash(&runtime_wasm),
        "reverseWasmSha256": hash(&reverse_wasm),
        "beforeStateSha256": paused_hash,
        "convertedStateSha256": rehearsal["convertedSandboxStateSha256"],
        "status": "code_deployed"
    });
    write_json(&code_only_record_path, &code_only_record)?;
    let code_only_deploy =
        deploy_checked(imported.as_account(), &sandbox, &id, &runtime_wasm).await?;
    check_chain(&sandbox, &id, &hash(&runtime_wasm), &paused_hash).await?;
    recover(
        imported.as_account(),
        &sandbox,
        &id,
        &manifest_path,
        &code_only_record_path,
        &mut code_only_record,
        &old_wasm,
        &reverse_wasm,
        "rolled_back",
    )
    .await?;
    ensure!(
        code_only_record["status"] == "rolled_back"
            && sandbox.view_state(&id).await? == paused_state,
        "code-only recovery did not restore paused legacy city"
    );
    let evidence = json!({
        "scope": "testnet state imported into isolated sandbox; no live mutation",
        "contractId": id,
        "liveStateSha256": state_hash(&live_state),
        "pausedStateSha256": paused_hash,
        "convertedStateSha256": state_hash(&converted),
        "runtimeWasmSha256": hash(&runtime_wasm),
        "reverseWasmSha256": hash(&reverse_wasm),
        "forwardDeployTransactionHash": forward_deploy,
        "forwardMigrationTransactionHash": migration.outcome().transaction_hash.to_string(),
        "unpauseTransactionHash": unpause.outcome().transaction_hash.to_string(),
        "repauseTransactionHash": repause.outcome().transaction_hash.to_string(),
        "pauseOnlyTransitionVerified": true,
        "forwardRecovery": record,
        "interruptedReverseDeployTransactionHash": interrupted_reverse_deploy,
        "interruptedReverseRecovery": interrupted_reverse_record,
        "interruptedReverseRecovered": true,
        "codeOnlyDeployTransactionHash": code_only_deploy,
        "codeOnlyRecovery": code_only_record,
        "exactReverseVerified": true,
        "codeOnlyRecoveryVerified": true
    });
    let output = root().join(&args[3]);
    write_json(&output, &evidence)?;
    fs::remove_dir_all(&temporary)?;
    println!("Sandbox release runner drill passed: {}", output.display());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--plan") => {
            ensure!(
                args.len() == 2 || args.len() == 5,
                "use --plan <preflight> [<backup-dir> <runtime.wasm> <reverse.wasm>]"
            );
            let mut result = packet_check(if args.len() == 5 {
                &args[1..4]
            } else {
                &args[1..2]
            })?;
            if args.len() == 5 {
                let report = read_json(&root().join(&args[1]))?;
                let release = read_json(&root().join(string(&report, "releaseEvidenceFile")?))?;
                let reverse = fs::read(root().join(&args[4]))?;
                let reverse_hash = hash(&reverse);
                ensure!(
                    reverse_hash == string(&release["rehearsal"], "reverseWasmSha256")?,
                    "reverse WASM differs from final rehearsal"
                );
                result["reverseWasmSha256"] = json!(reverse_hash);
            }
            println!("{}", near_sdk::serde_json::to_string_pretty(&result)?);
            Ok(())
        }
        Some("--apply") => apply(&args[1..]).await,
        Some("--rollback") => {
            ensure!(
                args.len() == 4,
                "use --rollback <release-record> <reverse.wasm> <service-data-dir>"
            );
            rollback(
                &root().join(&args[1]),
                &PathBuf::from(&args[2]),
                &root().join(&args[3]),
            )
            .await
        }
        Some("--rollback-finalize") => rollback_finalize(&args[1..]).await,
        Some("--sandbox-drill") => sandbox_drill(&args[1..]).await,
        Some("--resume-plan") => reopen_city(&args[1..], ReopenMode::Plan).await,
        Some("--resume-apply") => reopen_city(&args[1..], ReopenMode::Apply).await,
        Some("--resume-verify") => reopen_city(&args[1..], ReopenMode::Verify).await,
        _ => anyhow::bail!(
            "use --plan, --apply, --rollback, --rollback-finalize, --sandbox-drill, --resume-plan, --resume-apply or --resume-verify"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recovery_requires_an_exact_known_state_and_code() {
        let mut record = json!({
            "beforeWasmSha256": "old-code",
            "afterWasmSha256": "forward-code",
            "reverseWasmSha256": "reverse-code",
            "beforeStateSha256": "old-state",
            "convertedStateSha256": "converted-state"
        });
        assert!(
            !converted_recovery_state(&record, "forward-code", "old-state")
                .expect("code-only release can restore old state")
        );
        assert!(
            converted_recovery_state(&record, "forward-code", "converted-state")
                .expect("converted release can reverse")
        );
        assert!(
            converted_recovery_state(&record, "reverse-code", "converted-state")
                .expect("interrupted reverse can resume")
        );
        assert!(converted_recovery_state(&record, "old-code", "converted-state").is_err());
        assert!(converted_recovery_state(&record, "unknown-code", "old-state").is_err());
        assert!(converted_recovery_state(&record, "forward-code", "unknown-state").is_err());
        record["migrationTransactionHash"] = json!("successful-migration");
        assert!(converted_recovery_state(&record, "forward-code", "old-state").is_err());
        assert!(
            !converted_recovery_state(&record, "reverse-code", "old-state")
                .expect("completed reverse can resume before its transaction is recorded")
        );
        record["reverseTransactionHash"] = json!("successful-reverse");
        assert!(!converted_recovery_state(&record, "old-code", "old-state")
            .expect("recorded reverse can resume after old code is restored"));
    }
}
