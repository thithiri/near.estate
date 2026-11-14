use anyhow::{bail, ensure, Context, Result};
use near_estate_city_migration::CityRootV2;
use near_sdk::{
    borsh::{self, BorshDeserialize},
    serde_json::{json, Value},
};
use near_workspaces::{
    network::{NetworkClient, NetworkInfo},
    Account, AccountId, Worker,
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::Duration,
};

fn repo() -> PathBuf {
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

fn root_state(state: &HashMap<Vec<u8>, Vec<u8>>) -> Result<CityRootV2> {
    Ok(BorshDeserialize::try_from_slice(
        state
            .get(b"STATE".as_slice())
            .context("city root missing")?,
    )?)
}

fn unpaused_hash(state: &HashMap<Vec<u8>, Vec<u8>>) -> Result<String> {
    let mut root = root_state(state)?;
    ensure!(root.paused, "city is not paused");
    root.paused = false;
    let mut restored = state.clone();
    restored.insert(b"STATE".to_vec(), borsh::to_vec(&root)?);
    Ok(state_hash(&restored))
}

fn read_json(path: &Path) -> Result<Value> {
    Ok(near_sdk::serde_json::from_slice(&fs::read(path)?)?)
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    let bytes = format!("{}\n", near_sdk::serde_json::to_string_pretty(value)?);
    fs::write(&temporary, bytes)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn field<'a>(value: &'a Value, name: &str) -> Result<&'a str> {
    value[name]
        .as_str()
        .with_context(|| format!("missing {name}"))
}

fn candidate() -> Result<Vec<u8>> {
    let path = std::env::var_os("ESTATE_V2_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            repo().join(
                "contracts/city-migration/target/wasm32-unknown-unknown/release/near_estate_city_migration.wasm",
            )
        });
    let bytes = fs::read(path).context("build the version-2 runtime WASM first")?;
    ensure!(bytes.starts_with(b"\0asm"), "candidate WASM is invalid");
    Ok(bytes)
}

fn release_paths(candidate_hash: &str) -> (PathBuf, PathBuf, PathBuf) {
    let prefix = &candidate_hash[..16];
    (
        repo().join(format!("deployments/runtime-upgrade-sandbox-{prefix}.json")),
        repo().join(format!("deployments/runtime-upgrade-plan-{prefix}.json")),
        repo().join(format!("deployments/runtime-upgrade-live-{prefix}.json")),
    )
}

async fn views<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
) -> Result<Vec<Value>> {
    let mut result = vec![
        worker
            .view(id, "get_plot")
            .args_json(json!({"plot_id": "plot-main-n-3"}))
            .await?
            .json()?,
        worker.view(id, "get_config").await?.json()?,
        worker.view(id, "get_roles").await?.json()?,
    ];
    for road_id in ["main", "market", "river", "central", "harbor"] {
        for side in ["North", "South"] {
            let street: Value = worker
                .view(id, "get_street_side")
                .args_json(json!({"road_id": road_id, "side": side}))
                .await?
                .json()?;
            let plots = street["plots"].as_array().context("street plots missing")?;
            ensure!(plots.len() == 10, "street side does not have ten plots");
            result.push(street);
        }
    }
    ensure!(!result[0].is_null(), "review plot is missing");
    Ok(result)
}

async fn live_snapshot<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
) -> Result<(String, HashMap<Vec<u8>, Vec<u8>>, String)> {
    let code = hash(&worker.view_code(id).await?);
    let state = worker.view_state(id).await?;
    let view_hash = hash(&near_sdk::serde_json::to_vec(&views(worker, id).await?)?);
    Ok((code, state, view_hash))
}

async fn wait_code<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
    expected: &str,
) -> Result<()> {
    for _ in 0..20 {
        if hash(&worker.view_code(id).await?) == expected {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    bail!("deployed code did not reach finalized reads")
}

fn backup_path(key_file: &Path, old_hash: &str) -> Result<PathBuf> {
    let parent = key_file.parent().context("deployment key has no parent")?;
    ensure!(
        !parent.starts_with(repo().canonicalize()?),
        "deployment key and backup must be outside the repository"
    );
    let directory = parent.join("estate-city-release-backups");
    fs::create_dir_all(&directory)?;
    Ok(directory.join(format!("{old_hash}.wasm")))
}

fn save_backup(path: &Path, bytes: &[u8], expected: &str) -> Result<()> {
    if path.exists() {
        ensure!(
            hash(&fs::read(path)?) == expected,
            "old-code backup differs"
        );
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    ensure!(hash(&fs::read(path)?) == expected, "old-code backup failed");
    Ok(())
}

fn signer<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
) -> Result<(Account, PathBuf)> {
    let key_file = PathBuf::from(
        std::env::var("ESTATE_DEPLOY_KEY_FILE").context("ESTATE_DEPLOY_KEY_FILE is required")?,
    )
    .canonicalize()?;
    let account = Account::from_file(&key_file, worker)?;
    ensure!(
        account.id() == id,
        "deployment key belongs to another account"
    );
    Ok((account, key_file))
}

async fn set_pause(deployer: &Account, id: &AccountId, paused: bool) -> Result<String> {
    let result = deployer
        .call(id, "set_paused")
        .args_json(json!({"paused": paused}))
        .transact()
        .await?;
    ensure!(result.is_success(), "pause transaction failed: {result:?}");
    Ok(result.outcome().transaction_hash.to_string())
}

async fn recover<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
    deployer: &Account,
    old_wasm: &[u8],
    record_path: &Path,
    record: &mut Value,
) -> Result<()> {
    let old_hash = field(record, "beforeWasmSha256")?.to_string();
    let candidate_hash = field(record, "afterWasmSha256")?.to_string();
    let before_hash = field(record, "beforeStateSha256")?.to_string();
    ensure!(
        hash(old_wasm) == old_hash,
        "private old-code backup differs"
    );
    let code = hash(&worker.view_code(id).await?);
    let state = worker.view_state(id).await?;
    ensure!(
        code == old_hash || code == candidate_hash,
        "unknown live code; refusing automatic recovery"
    );
    let paused = root_state(&state)?.paused;
    if !paused {
        ensure!(
            code == old_hash && state_hash(&state) == before_hash,
            "city is already open or state changed; inspect before recovery"
        );
    } else {
        ensure!(
            unpaused_hash(&state)? == before_hash,
            "paused city storage differs from the pre-upgrade state"
        );
        if code == candidate_hash {
            let result = deployer.deploy(old_wasm).await?;
            ensure!(
                result.is_success(),
                "old code restore failed: {:?}",
                result.details
            );
            record["rollbackTransactionHash"] =
                json!(result.details.outcome().transaction_hash.to_string());
            write_json(record_path, record)?;
            wait_code(worker, id, &old_hash).await?;
            ensure!(
                unpaused_hash(&worker.view_state(id).await?)? == before_hash,
                "storage changed during old-code restore"
            );
        }
        record["reopenOldTransactionHash"] = json!(set_pause(deployer, id, false).await?);
        write_json(record_path, record)?;
    }
    ensure!(
        hash(&worker.view_code(id).await?) == old_hash
            && state_hash(&worker.view_state(id).await?) == before_hash,
        "recovery did not restore exact old code and state"
    );
    ensure!(
        hash(&near_sdk::serde_json::to_vec(&views(worker, id).await?)?)
            == field(record, "beforePublicViewsSha256")?,
        "recovery did not restore original public views"
    );
    record["status"] = json!("rolled_back");
    write_json(record_path, record)?;
    Ok(())
}

async fn sandbox_drill(
    testnet: &Worker<near_workspaces::network::Testnet>,
    id: &AccountId,
    plan: &Value,
    candidate: &[u8],
) -> Result<Value> {
    let sandbox = near_workspaces::sandbox().await?;
    let imported = sandbox
        .import_contract(id, testnet)
        .with_data()
        .transact()
        .await?;
    let deployer = imported.as_account();
    let old_wasm = sandbox.view_code(id).await?;
    let old_hash = field(plan, "beforeWasmSha256")?;
    let candidate_hash = field(plan, "afterWasmSha256")?;
    let state_before = sandbox.view_state(id).await?;
    let views_before = views(&sandbox, id).await?;
    ensure!(
        hash(&old_wasm) == old_hash
            && state_hash(&state_before) == field(plan, "beforeStateSha256")?
            && hash(&near_sdk::serde_json::to_vec(&views_before)?)
                == field(plan, "beforePublicViewsSha256")?,
        "sandbox import differs from reviewed live plan"
    );

    set_pause(deployer, id, true).await?;
    let paused_state = sandbox.view_state(id).await?;
    ensure!(
        unpaused_hash(&paused_state)? == field(plan, "beforeStateSha256")?,
        "sandbox pause changed city data"
    );
    let deployed = deployer.deploy(candidate).await?;
    ensure!(deployed.is_success(), "sandbox candidate deploy failed");
    ensure!(
        hash(&sandbox.view_code(id).await?) == candidate_hash
            && sandbox.view_state(id).await? == paused_state,
        "sandbox candidate changed paused state or code"
    );
    set_pause(deployer, id, false).await?;
    ensure!(
        sandbox.view_state(id).await? == state_before && views(&sandbox, id).await? == views_before,
        "sandbox candidate reopening changed city"
    );
    set_pause(deployer, id, true).await?;
    let mut recovery_record = json!({
        "beforeWasmSha256": old_hash,
        "afterWasmSha256": candidate_hash,
        "beforeStateSha256": field(plan, "beforeStateSha256")?,
        "beforePublicViewsSha256": field(plan, "beforePublicViewsSha256")?,
        "status": "recovery_required",
    });
    let recovery_path = std::env::temp_dir().join(format!(
        "estate-runtime-upgrade-drill-{}-{}.json",
        std::process::id(),
        &candidate_hash[..16]
    ));
    ensure!(
        !recovery_path.exists(),
        "sandbox drill record already exists"
    );
    write_json(&recovery_path, &recovery_record)?;
    let recovery_result = recover(
        &sandbox,
        id,
        deployer,
        &old_wasm,
        &recovery_path,
        &mut recovery_record,
    )
    .await;
    fs::remove_file(&recovery_path)?;
    recovery_result?;
    ensure!(
        sandbox.view_state(id).await? == state_before
            && hash(&sandbox.view_code(id).await?) == old_hash
            && views(&sandbox, id).await? == views_before,
        "sandbox recovery did not restore original city"
    );
    Ok(json!({
        "scope": "local sandbox only; no signed testnet transactions",
        "contractId": id,
        "beforeWasmSha256": old_hash,
        "afterWasmSha256": candidate_hash,
        "beforeStateSha256": field(plan, "beforeStateSha256")?,
        "pausedUpgradeReopenVerified": true,
        "sameRecoveryFunctionVerified": true,
        "rollbackRestoredExactStateAndViews": true,
    }))
}

#[tokio::main]
async fn main() -> Result<()> {
    let mode = std::env::args().nth(1).unwrap_or_default();
    ensure!(
        [
            "--plan",
            "--apply",
            "--recover",
            "--finalize",
            "--sandbox-drill"
        ]
        .contains(&mode.as_str()),
        "use --plan, --apply, --recover, --finalize or --sandbox-drill"
    );
    let manifest_path = repo().join("deployments/testnet.json");
    let manifest = read_json(&manifest_path)?;
    ensure!(manifest["network"] == "testnet", "manifest is not testnet");
    let id: AccountId = field(&manifest, "contractId")?.parse()?;
    let manifest_code_hash = field(&manifest, "wasmSha256")?.to_string();
    let candidate = candidate()?;
    let candidate_hash = hash(&candidate);
    let (rehearsal_path, plan_path, record_path) = release_paths(&candidate_hash);
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

    if mode == "--plan" {
        ensure!(
            !record_path.exists(),
            "live release record exists; inspect it first"
        );
        let rehearsal = read_json(&rehearsal_path).context("run sandbox rehearsal first")?;
        ensure!(
            rehearsal["contractId"] == id.to_string()
                && rehearsal["liveCodeSha256"] == manifest_code_hash
                && rehearsal["candidateCodeSha256"] == candidate_hash
                && rehearsal["candidatePreservedPausedState"] == true
                && rehearsal["publicViewsUnchanged"] == true
                && rehearsal["rollbackPublicViewsUnchanged"] == true,
            "sandbox rehearsal does not match this candidate and live code"
        );
        let (live_code, state, view_hash) = live_snapshot(&worker, &id).await?;
        ensure!(
            live_code == manifest_code_hash,
            "live code differs from manifest"
        );
        let state_hash_now = state_hash(&state);
        ensure!(
            rehearsal["stateSha256Before"] == state_hash_now
                && rehearsal["publicViewsSha256"] == view_hash,
            "live city changed since rehearsal; rerun it"
        );
        let city = root_state(&state)?;
        ensure!(
            !city.paused
                && city.city_version == 2
                && city.plot_count == 100
                && u64::from(city.npc_site_count)
                    == manifest["npcSiteCount"]
                        .as_u64()
                        .context("manifest NPC site count missing")?
                && city.admin == id,
            "live city root differs from release expectations"
        );
        let plan = json!({
            "scope": "read-only live testnet plan",
            "status": "ready",
            "contractId": id,
            "beforeWasmSha256": manifest_code_hash,
            "afterWasmSha256": candidate_hash,
            "beforeStateSha256": state_hash_now,
            "beforePublicViewsSha256": view_hash,
            "stateEntries": state.len(),
            "rehearsalFile": rehearsal_path.strip_prefix(repo())?.to_string_lossy(),
        });
        write_json(&plan_path, &plan)?;
        println!("{}", near_sdk::serde_json::to_string_pretty(&plan)?);
        return Ok(());
    }

    let plan = read_json(&plan_path).context("run --plan first")?;
    let old_hash = field(&plan, "beforeWasmSha256")?.to_string();
    let rehearsal = read_json(&rehearsal_path).context("sandbox rehearsal is missing")?;
    ensure!(
        plan["status"] == "ready"
            && plan["contractId"] == id.to_string()
            && (manifest_code_hash == old_hash || manifest_code_hash == candidate_hash)
            && plan["afterWasmSha256"] == candidate_hash
            && rehearsal["contractId"] == id.to_string()
            && rehearsal["liveCodeSha256"] == old_hash
            && rehearsal["candidateCodeSha256"] == candidate_hash
            && rehearsal["stateSha256Before"] == plan["beforeStateSha256"]
            && rehearsal["publicViewsSha256"] == plan["beforePublicViewsSha256"]
            && rehearsal["stateEntries"] == plan["stateEntries"]
            && rehearsal["candidatePreservedPausedState"] == true
            && rehearsal["rollbackPublicViewsUnchanged"] == true,
        "release plan differs from rehearsal, manifest or candidate"
    );
    if mode == "--sandbox-drill" {
        let result = sandbox_drill(&worker, &id, &plan, &candidate).await?;
        let path = repo().join(format!(
            "deployments/runtime-upgrade-drill-{}.json",
            &candidate_hash[..16]
        ));
        write_json(&path, &result)?;
        println!("{}", near_sdk::serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    if mode == "--apply" {
        ensure!(
            manifest_code_hash == old_hash,
            "manifest has already advanced; inspect the release record"
        );
        let (deployer, key_file) = signer(&worker, &id)?;
        let backup = backup_path(&key_file, &old_hash)?;
        ensure!(
            !record_path.exists(),
            "release record exists; recover or finalize it"
        );
        let (live_code, state, view_hash) = live_snapshot(&worker, &id).await?;
        ensure!(
            live_code == old_hash
                && state_hash(&state) == field(&plan, "beforeStateSha256")?
                && view_hash == field(&plan, "beforePublicViewsSha256")?,
            "live city changed since plan; rerun rehearsal and plan"
        );
        ensure!(!root_state(&state)?.paused, "city is already paused");
        let old_wasm = worker.view_code(&id).await?;
        ensure!(hash(&old_wasm) == old_hash, "live old code changed");
        save_backup(&backup, &old_wasm, &old_hash)?;
        let mut record = json!({
            "network": "testnet", "contractId": id, "status": "prepared",
            "beforeWasmSha256": old_hash, "afterWasmSha256": candidate_hash,
            "beforeStateSha256": field(&plan, "beforeStateSha256")?,
            "beforePublicViewsSha256": field(&plan, "beforePublicViewsSha256")?,
        });
        write_json(&record_path, &record)?;
        let result = async {
            record["status"] = json!("pausing");
            write_json(&record_path, &record)?;
            record["pauseTransactionHash"] = json!(set_pause(&deployer, &id, true).await?);
            let paused_state = worker.view_state(&id).await?;
            ensure!(
                unpaused_hash(&paused_state)? == field(&plan, "beforeStateSha256")?,
                "pause changed city data"
            );
            record["pausedStateSha256"] = json!(state_hash(&paused_state));
            record["status"] = json!("paused");
            write_json(&record_path, &record)?;
            let deployed = deployer.deploy(&candidate).await?;
            ensure!(
                deployed.is_success(),
                "candidate deploy failed: {:?}",
                deployed.details
            );
            record["deployTransactionHash"] =
                json!(deployed.details.outcome().transaction_hash.to_string());
            record["status"] = json!("code_deployed");
            write_json(&record_path, &record)?;
            wait_code(&worker, &id, &candidate_hash).await?;
            ensure!(
                state_hash(&worker.view_state(&id).await?) == field(&record, "pausedStateSha256")?,
                "candidate changed paused storage"
            );
            let paused_view: bool = worker.view(&id, "is_paused").await?.json()?;
            ensure!(paused_view, "candidate reopened city during deployment");
            ensure!(
                hash(&near_sdk::serde_json::to_vec(&views(&worker, &id).await?)?)
                    == field(&plan, "beforePublicViewsSha256")?,
                "candidate changed public city views"
            );
            record["status"] = json!("candidate_verified");
            write_json(&record_path, &record)?;
            record["status"] = json!("reopening");
            write_json(&record_path, &record)?;
            record["reopenTransactionHash"] = json!(set_pause(&deployer, &id, false).await?);
            record["status"] = json!("reopened");
            write_json(&record_path, &record)?;
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            record["failure"] = json!(error.to_string());
            record["status"] = json!("recovery_required");
            write_json(&record_path, &record)?;
            let current = worker.view_state(&id).await?;
            if root_state(&current)?.paused {
                recover(
                    &worker,
                    &id,
                    &deployer,
                    &old_wasm,
                    &record_path,
                    &mut record,
                )
                .await
                .context("automatic rollback failed; inspect release record")?;
            } else if hash(&worker.view_code(&id).await?) == candidate_hash {
                record["status"] = json!("reopen_review_required");
                write_json(&record_path, &record)?;
            }
            return Err(error);
        }
    }

    let mut record = read_json(&record_path).context("live release record missing")?;
    ensure!(
        record["contractId"] == id.to_string() && record["afterWasmSha256"] == candidate_hash,
        "release record differs"
    );
    if mode == "--recover" {
        ensure!(
            record["status"] != "verified",
            "verified release cannot be recovered here"
        );
        let (deployer, key_file) = signer(&worker, &id)?;
        let backup = backup_path(&key_file, &old_hash)?;
        let old_wasm = fs::read(&backup).context("private old-code backup missing")?;
        recover(
            &worker,
            &id,
            &deployer,
            &old_wasm,
            &record_path,
            &mut record,
        )
        .await?;
        let mut manifest = read_json(&manifest_path)?;
        ensure!(
            manifest["wasmSha256"] == old_hash || manifest["wasmSha256"] == candidate_hash,
            "manifest changed to an unexpected code hash"
        );
        manifest["wasmSha256"] = json!(old_hash);
        write_json(&manifest_path, &manifest)?;
        return Ok(());
    }
    ensure!(
        record["status"] == "reopened"
            || record["status"] == "reopening"
            || record["status"] == "reopen_review_required",
        "city has not reached the reopen stage"
    );
    let live_code = hash(&worker.view_code(&id).await?);
    ensure!(live_code == candidate_hash, "candidate code is not live");
    let state = worker.view_state(&id).await?;
    let city = root_state(&state)?;
    ensure!(
        !city.paused && city.city_version == 2 && city.plot_count == 100 && city.admin == id,
        "candidate city is not open with expected layout"
    );
    let _ = views(&worker, &id).await?;
    let mut manifest = read_json(&manifest_path)?;
    ensure!(
        manifest["wasmSha256"] == old_hash || manifest["wasmSha256"] == candidate_hash,
        "manifest changed to an unexpected code hash"
    );
    manifest["wasmSha256"] = json!(candidate_hash);
    write_json(&manifest_path, &manifest)?;
    record["status"] = json!("verified");
    record["finalCodeSha256"] = json!(live_code);
    record["finalStateSha256"] = json!(state_hash(&state));
    write_json(&record_path, &record)?;
    println!("Verified live code-only upgrade: {}", record_path.display());
    Ok(())
}
