use anyhow::{ensure, Context, Result};
use near_estate_contract::{
    AccountState, Car, Facility, NPCSite, ParkingRule, ParkingSession, Plot, ServiceRole,
};
use near_estate_migration_probe::{RootV1, RootV2};
use near_sdk::{
    borsh::{self, BorshDeserialize, BorshSerialize},
    serde_json::{json, Value},
};
use near_workspaces::{
    network::{NetworkClient, NetworkInfo},
    types::NearToken,
    AccountId, Worker,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    hash::Hash,
    path::PathBuf,
    process::Command,
};

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

fn decode_map<K, V>(state: &HashMap<Vec<u8>, Vec<u8>>, prefix: u8) -> Result<HashMap<K, V>>
where
    K: BorshDeserialize + BorshSerialize + Eq + Hash,
    V: BorshDeserialize + BorshSerialize,
{
    let mut decoded = HashMap::new();
    for (raw_key, raw_value) in state.iter().filter(|(key, _)| key.first() == Some(&prefix)) {
        let key: K = borsh::from_slice(&raw_key[1..])
            .with_context(|| format!("invalid key under prefix {}", prefix as char))?;
        let value: V = borsh::from_slice(raw_value)
            .with_context(|| format!("invalid value under prefix {}", prefix as char))?;
        ensure!(borsh::to_vec(&key)? == raw_key[1..], "noncanonical map key");
        ensure!(
            borsh::to_vec(&value)? == *raw_value,
            "map value did not round trip"
        );
        ensure!(
            decoded.insert(key, value).is_none(),
            "duplicate decoded map key"
        );
    }
    Ok(decoded)
}

fn audit_live_records(state: &HashMap<Vec<u8>, Vec<u8>>, root: &RootV1) -> Result<Value> {
    let accounts: HashMap<AccountId, AccountState> = decode_map(state, b'a')?;
    let cars: HashMap<u64, Car> = decode_map(state, b'c')?;
    let plots: HashMap<String, Plot> = decode_map(state, b'p')?;
    let plot_ids: HashMap<u16, String> = decode_map(state, b'i')?;
    let npc_sites: HashMap<String, NPCSite> = decode_map(state, b'n')?;
    let npc_ids: HashMap<u8, String> = decode_map(state, b'j')?;
    let sessions: HashMap<u64, ParkingSession> = decode_map(state, b's')?;
    let occupied: HashMap<String, u64> = decode_map(state, b'o')?;
    let total = 1
        + accounts.len()
        + cars.len()
        + plots.len()
        + plot_ids.len()
        + npc_sites.len()
        + npc_ids.len()
        + sessions.len()
        + occupied.len();
    ensure!(total == state.len(), "unknown storage key or prefix");
    ensure!(
        plots.len() == usize::from(root.plot_count),
        "plot count differs"
    );
    ensure!(plot_ids.len() == plots.len(), "plot index count differs");
    ensure!(
        npc_sites.len() == usize::from(root.npc_site_count),
        "NPC count differs"
    );
    ensure!(npc_ids.len() == npc_sites.len(), "NPC index count differs");
    ensure!(
        sessions.len() == occupied.len(),
        "occupied-space count differs"
    );
    for index in 0..root.plot_count {
        let id = plot_ids.get(&index).context("missing plot index")?;
        ensure!(plots.contains_key(id), "plot index points to missing plot");
    }
    for index in 0..root.npc_site_count {
        let id = npc_ids.get(&index).context("missing NPC index")?;
        ensure!(
            npc_sites.contains_key(id),
            "NPC index points to missing site"
        );
    }
    for (id, plot) in &plots {
        ensure!(plot.id == *id, "plot key and ID differ");
        if let Some(owner) = &plot.owner {
            ensure!(accounts.contains_key(owner), "plot owner is unregistered");
            ensure!(
                plot.used_storage_bytes <= plot.reserved_storage_bytes,
                "plot storage reserve exceeded"
            );
        }
    }
    for (id, site) in &npc_sites {
        ensure!(site.id == *id, "NPC key and ID differ");
    }
    let mut listed_cars = HashSet::new();
    let mut total_coins: u128 = root.treasury_coins.0;
    for (id, account) in &accounts {
        total_coins = total_coins
            .checked_add(account.balance.0)
            .context("coin total overflow")?;
        ensure!(
            account.car_ids.len() <= usize::from(root.config.max_cars),
            "account exceeds car limit"
        );
        ensure!(
            account.used_storage_bytes <= account.reserved_storage_bytes,
            "account storage reserve exceeded"
        );
        ensure!(
            account.car_ids.contains(&account.starter_car_id),
            "starter car absent from account"
        );
        for car_id in &account.car_ids {
            ensure!(
                listed_cars.insert(*car_id),
                "car listed by multiple accounts"
            );
            ensure!(
                cars.get(car_id).is_some_and(|car| &car.owner == id),
                "account car owner mismatch"
            );
        }
        if let Some(session_id) = account.active_session_id {
            ensure!(
                sessions
                    .get(&session_id)
                    .is_some_and(|session| &session.driver == id),
                "account active session mismatch"
            );
        }
    }
    ensure!(listed_cars.len() == cars.len(), "unlisted car exists");
    for (id, car) in &cars {
        ensure!(
            *id == car.id && *id < root.next_car_id,
            "car key or ID counter differs"
        );
        ensure!(
            accounts.contains_key(&car.owner),
            "car owner is unregistered"
        );
        if let Some(session_id) = car.parked_session_id {
            ensure!(
                sessions
                    .get(&session_id)
                    .is_some_and(|session| session.car_id == *id),
                "car parked session mismatch"
            );
        }
    }
    for (id, session) in &sessions {
        ensure!(
            *id == session.id && *id < root.next_session_id,
            "session key or ID counter differs"
        );
        ensure!(
            cars.get(&session.car_id).is_some_and(
                |car| car.parked_session_id == Some(*id) && car.owner == session.driver
            ),
            "session car mismatch"
        );
        ensure!(
            accounts
                .get(&session.driver)
                .is_some_and(|account| account.active_session_id == Some(*id)),
            "session driver mismatch"
        );
        let space_key = match session.facility {
            Facility::Curb => {
                ensure!(
                    plots.contains_key(&session.location_id) && session.slot < 2,
                    "invalid curb session"
                );
                format!("c:{}:{}", session.location_id, session.slot)
            }
            Facility::Tower => {
                ensure!(
                    npc_sites
                        .get(&session.location_id)
                        .is_some_and(|site| site.role == ServiceRole::ParkingTower
                            && session.slot < site.capacity),
                    "invalid tower session"
                );
                format!("t:{}:{}", session.location_id, session.slot)
            }
        };
        ensure!(
            occupied.get(&space_key) == Some(id),
            "session occupied-space link differs"
        );
    }
    Ok(json!({
        "accounts": accounts.len(),
        "cars": cars.len(),
        "plots": plots.len(),
        "plotIndexes": plot_ids.len(),
        "npcSites": npc_sites.len(),
        "npcIndexes": npc_ids.len(),
        "activeSessions": sessions.len(),
        "occupiedSpaces": occupied.len(),
        "accountAndTreasuryCoins": total_coins.to_string(),
    }))
}

fn build_probe(reverse: bool) -> Result<Vec<u8>> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let mut command = Command::new(cargo);
    command
        .args([
            "build",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "-p",
            "near-estate-migration-probe",
        ])
        .current_dir(root());
    if reverse {
        command.args(["--features", "reverse"]);
    }
    let status = command
        .status()
        .context("could not build migration probe")?;
    ensure!(status.success(), "migration probe WASM build failed");
    let wasm = std::fs::read(
        root().join("target/wasm32-unknown-unknown/release/near_estate_migration_probe.wasm"),
    )?;
    ensure!(
        wasm.starts_with(b"\0asm"),
        "migration probe WASM is invalid"
    );
    Ok(wasm)
}

async fn old_views<N: NetworkClient + NetworkInfo + Send + Sync + 'static>(
    worker: &Worker<N>,
    id: &AccountId,
    owner: &AccountId,
) -> Result<Value> {
    let roles: Value = worker.view(id, "get_roles").await?.json()?;
    let config: Value = worker.view(id, "get_config").await?.json()?;
    let plot_count: u16 = worker.view(id, "plot_count").await?.json()?;
    let site_count: u8 = worker.view(id, "npc_site_count").await?.json()?;
    let tower: u8 = worker
        .view(id, "get_tower_availability")
        .args_json(json!({"site_id": "npc-main-tower"}))
        .await?
        .json()?;
    let street: Value = worker
        .view(id, "get_street_side")
        .args_json(json!({"road_id": "main", "side": "North"}))
        .await?
        .json()?;
    let account: Value = worker
        .view(id, "get_account")
        .args_json(json!({"account_id": owner}))
        .await?
        .json()?;
    let cars: Value = worker
        .view(id, "get_cars")
        .args_json(json!({"account_id": owner}))
        .await?
        .json()?;
    Ok(json!({
        "roles": roles,
        "config": config,
        "plotCount": plot_count,
        "siteCount": site_count,
        "towerAvailable": tower,
        "street": street,
        "account": account,
        "cars": cars,
    }))
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--live-import"),
        "use --live-import; this command only writes to a local sandbox"
    );
    let manifest: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(root().join("deployments/testnet.json"))?)?;
    ensure!(manifest["network"] == "testnet", "manifest is not testnet");
    let id: AccountId = manifest["contractId"]
        .as_str()
        .context("contract ID missing")?
        .parse()?;
    let expected_old_hash = manifest["wasmSha256"]
        .as_str()
        .context("contract code hash missing")?;
    let owner_record: Value = near_sdk::serde_json::from_slice(&std::fs::read(
        root().join("deployments/testnet-shared-owner-journey.json"),
    )?)?;
    ensure!(
        owner_record["contractId"] == id.as_str(),
        "owner record belongs to another city"
    );
    let owner: AccountId = owner_record["ownerId"]
        .as_str()
        .context("owner ID missing")?
        .parse()?;
    let forward_wasm = build_probe(false)?;
    let reverse_wasm = build_probe(true)?;
    let rpc_url = std::env::var("ESTATE_TESTNET_RPC_URL")
        .unwrap_or_else(|_| "https://test.rpc.fastnear.com".to_string());
    ensure!(rpc_url.starts_with("https://"), "RPC must use HTTPS");
    let testnet = near_workspaces::testnet().rpc_addr(&rpc_url).await?;
    ensure!(
        testnet.status().await?.chain_id == "testnet",
        "RPC is not testnet"
    );
    let old_wasm = testnet.view_code(&id).await?;
    ensure!(
        hash(&old_wasm) == expected_old_hash,
        "live code differs from manifest"
    );
    let live_state = testnet.view_state(&id).await?;
    let before_hash = state_hash(&live_state);
    let root_bytes = live_state
        .get(b"STATE".as_slice())
        .context("live root state missing")?;
    let old_root: RootV1 =
        borsh::from_slice(root_bytes).context("live V1 root cannot be decoded")?;
    ensure!(
        old_root.admin == id && old_root.plot_count == 80 && old_root.npc_site_count == 7,
        "unexpected live root"
    );
    ensure!(
        borsh::to_vec(&old_root)? == *root_bytes,
        "V1 root did not round trip exactly"
    );
    let record_audit = audit_live_records(&live_state, &old_root)?;
    let expected_views = old_views(&testnet, &id, &owner).await?;
    println!("Importing the exact live city into a local sandbox...");
    let sandbox = near_workspaces::sandbox().await?;
    let copy = sandbox
        .import_contract(&id, &testnet)
        .with_data()
        .transact()
        .await?;
    ensure!(
        hash(&sandbox.view_code(&id).await?) == expected_old_hash,
        "sandbox code differs"
    );
    ensure!(
        state_hash(&sandbox.view_state(&id).await?) == before_hash,
        "sandbox state differs"
    );
    ensure!(
        audit_live_records(&sandbox.view_state(&id).await?, &old_root)? == record_audit,
        "sandbox record audit differs"
    );
    ensure!(
        old_views(&sandbox, &id, &owner).await? == expected_views,
        "sandbox views differ"
    );
    // Add a sandbox-only active session so the migration exercises the stored
    // parking terms and occupancy links absent from the live snapshot.
    let occupied_live: HashMap<String, u64> = decode_map(&live_state, b'o')?;
    let live_session_count = record_audit["activeSessions"]
        .as_u64()
        .context("live session count missing")?;
    let free_plot = decode_map::<String, Plot>(&live_state, b'p')?
        .into_values()
        .find(|plot| {
            plot.owner.is_none()
                && plot.pending_rule.is_none()
                && plot.rule == ParkingRule::Free
                && !occupied_live.contains_key(&format!("c:{}:0", plot.id))
        })
        .context("no unowned Free plot for sandbox mutation")?;
    let driver = sandbox.dev_create_account().await?;
    let registration_quote: String = sandbox.view(&id, "registration_quote").await?.json()?;
    let registration = driver
        .call(&id, "register_player")
        .args_json(json!({"body": "Hatchback", "color": "Red"}))
        .deposit(NearToken::from_yoctonear(registration_quote.parse()?))
        .transact()
        .await?;
    ensure!(
        registration.is_success(),
        "sandbox registration failed: {registration:?}"
    );
    let registered_car: Value = registration.json()?;
    let car_id = registered_car["id"]
        .as_u64()
        .context("registered car ID missing")?;
    let parked = driver
        .call(&id, "park")
        .args_json(json!({"car_id": car_id, "plot_id": free_plot.id, "slot": 0}))
        .transact()
        .await?;
    ensure!(parked.is_success(), "sandbox park failed: {parked:?}");
    let parked_session: Value = parked.json()?;
    let session_id = parked_session["id"]
        .as_u64()
        .context("parked session ID missing")?;
    let active_state = sandbox.view_state(&id).await?;
    let active_hash = state_hash(&active_state);
    let active_root_bytes = active_state
        .get(b"STATE".as_slice())
        .context("active root missing")?;
    let active_root: RootV1 = borsh::from_slice(active_root_bytes)?;
    let active_audit = audit_live_records(&active_state, &active_root)?;
    ensure!(
        active_audit["activeSessions"] == live_session_count + 1
            && active_audit["occupiedSpaces"] == live_session_count + 1,
        "active sandbox session was not audited"
    );
    let mut session_key = vec![b's'];
    session_key.extend_from_slice(&borsh::to_vec(&session_id)?);
    let active_session_bytes = active_state
        .get(&session_key)
        .context("active session storage missing")?;
    let deploy_forward = copy.as_account().deploy(&forward_wasm).await?;
    ensure!(deploy_forward.is_success(), "forward probe deploy failed");
    let outsider = sandbox.dev_create_account().await?;
    let unauthorized = outsider.call(&id, "migrate").transact().await?;
    ensure!(
        !unauthorized.is_success(),
        "outsider migrated contract state"
    );
    ensure!(
        state_hash(&sandbox.view_state(&id).await?) == active_hash,
        "failed migration changed state"
    );
    let migrated = copy.as_account().call(&id, "migrate").transact().await?;
    ensure!(migrated.is_success(), "migration failed: {migrated:?}");
    let migrated_state = sandbox.view_state(&id).await?;
    let new_root_bytes = migrated_state
        .get(b"STATE".as_slice())
        .context("V2 root missing")?;
    let new_root: RootV2 =
        borsh::from_slice(new_root_bytes).context("V2 root cannot be decoded")?;
    ensure!(new_root.schema_version == 2, "V2 marker differs");
    ensure!(
        audit_live_records(&migrated_state, &new_root.old)? == active_audit,
        "migrated records or economic totals differ"
    );
    let mut expected_root = active_root_bytes.clone();
    expected_root.extend_from_slice(&2u32.to_le_bytes());
    ensure!(
        *new_root_bytes == expected_root,
        "migration changed V1 root fields"
    );
    ensure!(
        migrated_state.len() == active_state.len()
            && active_state
                .iter()
                .all(|(key, value)| key.as_slice() == b"STATE"
                    || migrated_state.get(key) == Some(value)),
        "migration changed a non-root storage key"
    );
    ensure!(
        migrated_state.get(&session_key) == Some(active_session_bytes),
        "migration changed active session bytes"
    );
    let version: u32 = sandbox.view(&id, "get_schema_version").await?.json()?;
    ensure!(version == 2, "V2 view differs");
    let snapshot: Value = sandbox.view(&id, "get_root_snapshot").await?.json()?;
    ensure!(
        snapshot[0] == id.as_str() && snapshot[4] == 80 && snapshot[5] == 7,
        "V2 root view differs"
    );
    let second = copy.as_account().call(&id, "migrate").transact().await?;
    ensure!(!second.is_success(), "second migration succeeded");
    ensure!(
        sandbox.view_state(&id).await? == migrated_state,
        "second migration changed state"
    );
    let deploy_reverse = copy.as_account().deploy(&reverse_wasm).await?;
    ensure!(deploy_reverse.is_success(), "reverse probe deploy failed");
    let reversed = copy.as_account().call(&id, "reverse").transact().await?;
    ensure!(
        reversed.is_success(),
        "reverse migration failed: {reversed:?}"
    );
    ensure!(
        sandbox.view_state(&id).await? == active_state,
        "reverse migration did not restore exact state"
    );
    let restore_code = copy.as_account().deploy(&old_wasm).await?;
    ensure!(restore_code.is_success(), "old code restore failed");
    ensure!(
        hash(&sandbox.view_code(&id).await?) == expected_old_hash,
        "old code hash not restored"
    );
    ensure!(
        old_views(&sandbox, &id, &owner).await? == expected_views,
        "restored game views differ"
    );
    let restored_session: Value = sandbox
        .view(&id, "get_session")
        .args_json(json!({"session_id": session_id}))
        .await?
        .json()?;
    ensure!(
        restored_session == parked_session,
        "restored parking terms differ"
    );
    let collected = driver
        .call(&id, "collect")
        .args_json(json!({"expected_session_id": session_id}))
        .transact()
        .await?;
    ensure!(
        collected.is_success(),
        "sandbox collect failed: {collected:?}"
    );
    let collected_state = sandbox.view_state(&id).await?;
    let collected_root: RootV1 = borsh::from_slice(
        collected_state
            .get(b"STATE".as_slice())
            .context("collected root missing")?,
    )?;
    let collected_audit = audit_live_records(&collected_state, &collected_root)?;
    ensure!(
        collected_audit["activeSessions"] == live_session_count
            && collected_audit["occupiedSpaces"] == live_session_count,
        "collected sandbox session remained stored"
    );
    let record = json!({
        "result": "passed",
        "network": "testnet",
        "scope": "sandbox import only; no live testnet state changed",
        "contractId": id,
        "liveCodeSha256": expected_old_hash,
        "forwardProbeSha256": hash(&forward_wasm),
        "reverseProbeSha256": hash(&reverse_wasm),
        "liveImportedStateSha256": before_hash,
        "activeBeforeAndRestoredStateSha256": active_hash,
        "migratedStateSha256": state_hash(&migrated_state),
        "storageKeys": live_state.len(),
        "storedRecords": record_audit,
        "activeFixtureStoredRecords": active_audit,
        "activeSessionId": session_id,
        "schemaVersion": version,
        "unauthorizedRejected": true,
        "secondMigrationRejected": true,
        "nonRootStorageUnchanged": true,
        "oldViewsRestored": true,
        "activeSessionPreservedThroughMigration": true,
        "collectedSandboxSessionAudited": true,
    });
    let path = root().join("deployments/testnet-root-migration-rehearsal.json");
    let mut output = near_sdk::serde_json::to_vec_pretty(&record)?;
    output.push(b'\n');
    std::fs::write(&path, output)?;
    println!("Migration and exact reverse passed: {}", path.display());
    Ok(())
}
