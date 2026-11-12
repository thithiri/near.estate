#![recursion_limit = "256"]

use anyhow::{ensure, Context, Result};
use near_estate_city_migration::{CityRootV2, DeedMove, LegacyRoot};
use near_estate_contract::{BuildingType, Plot, PlotSeedV2, RoadId, Side};
use near_sdk::{
    borsh::{self, BorshDeserialize, BorshSerialize},
    serde_json::{json, Value},
};
use near_workspaces::{
    types::{AccessKey, AccessKeyPermission, Gas, KeyType, NearToken, SecretKey},
    Account, AccountId,
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, path::PathBuf, process::Command};

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
const GAMEPLAY_ALLOWANCE_YOCTO: u128 = 250_000_000_000_000_000_000_000;

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

fn borsh_hash<T: BorshSerialize>(value: &T) -> Result<String> {
    Ok(hash(&borsh::to_vec(value)?))
}

fn build_feature(target_dir: &PathBuf, feature: &str) -> Result<Vec<u8>> {
    ensure!(
        feature == "runtime" || feature == "reverse",
        "unknown city build feature"
    );
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let status = Command::new(cargo)
        .current_dir(root())
        .env("CARGO_TARGET_DIR", target_dir)
        .args([
            "build",
            "--manifest-path",
            "contracts/city-migration/Cargo.toml",
            "--release",
            "--target",
            "wasm32-unknown-unknown",
            "--features",
            feature,
        ])
        .status()
        .with_context(|| format!("could not build {feature} city WASM"))?;
    ensure!(status.success(), "{feature} city WASM build failed");
    let migration_wasm_path =
        target_dir.join("wasm32-unknown-unknown/release/near_estate_city_migration.wasm");
    let wasm = std::fs::read(&migration_wasm_path)?;
    ensure!(wasm.starts_with(b"\0asm"), "{feature} WASM is invalid");
    Ok(wasm)
}

fn map_value<K: BorshSerialize, V: BorshDeserialize>(
    state: &HashMap<Vec<u8>, Vec<u8>>,
    prefix: u8,
    key: &K,
) -> Result<V> {
    let mut raw_key = vec![prefix];
    raw_key.extend(borsh::to_vec(key)?);
    let value = state.get(&raw_key).context("storage map entry missing")?;
    Ok(borsh::from_slice(value)?)
}

fn parse_seeds() -> Result<Vec<PlotSeedV2>> {
    let city: Value = near_sdk::serde_json::from_slice(&std::fs::read(
        root().join("contracts/estate/seed-v2.json"),
    )?)?;
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

fn source_plots(state: &HashMap<Vec<u8>, Vec<u8>>, count: u16) -> Result<Vec<Plot>> {
    (0..count)
        .map(|index| {
            let id: String = map_value(state, b'i', &index)?;
            let plot: Plot = map_value(state, b'p', &id)?;
            ensure!(plot.id == id, "source plot index differs");
            Ok(plot)
        })
        .collect()
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure!(
        std::env::args().nth(1).as_deref() == Some("--live-import"),
        "use --live-import; this command only writes to a local sandbox"
    );
    let manifest: Value =
        near_sdk::serde_json::from_slice(&std::fs::read(root().join("deployments/testnet.json"))?)?;
    ensure!(
        manifest["network"] == "testnet",
        "deployment is not testnet"
    );
    let id: AccountId = manifest["contractId"]
        .as_str()
        .context("contract ID missing")?
        .parse()?;
    let expected_code_hash = manifest["wasmSha256"]
        .as_str()
        .context("deployed code hash missing")?;
    let target_dir = std::env::var_os("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target"));
    let migration_wasm_path =
        target_dir.join("wasm32-unknown-unknown/release/near_estate_city_migration.wasm");
    let wasm = build_feature(&target_dir, "runtime")?;
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
        hash(&old_wasm) == expected_code_hash,
        "deployed code differs from manifest"
    );
    let live_state = testnet.view_state(&id).await?;
    let live_root: LegacyRoot = borsh::from_slice(
        live_state
            .get(b"STATE".as_slice())
            .context("live root state missing")?,
    )?;
    ensure!(
        live_root.admin == id && live_root.plot_count == 80 && live_root.npc_site_count == 7,
        "unexpected live legacy root"
    );
    let live_plot_hash = borsh_hash(&source_plots(&live_state, 80)?)?;
    let seeds = parse_seeds()?;
    let target_seed_hash = borsh_hash(&seeds)?;
    let plan: Value = near_sdk::serde_json::from_slice(&std::fs::read(
        root().join("contracts/estate/migration-v1-to-v2-draft.json"),
    )?)?;
    let moves: Vec<DeedMove> = near_sdk::serde_json::from_value(plan["moves"].clone())?;

    println!("Importing the live city into an isolated sandbox...");
    let sandbox = near_workspaces::sandbox()
        .await
        .context("start isolated sandbox")?;
    let copy = sandbox
        .import_contract(&id, &testnet)
        .with_data()
        .transact()
        .await
        .context("import live contract and state into sandbox")?;
    let imported_state = sandbox
        .view_state(&id)
        .await
        .context("read imported sandbox state")?;
    ensure!(
        imported_state == live_state,
        "sandbox state differs from live import"
    );
    let pause = copy
        .as_account()
        .call(&id, "set_paused")
        .args_json(json!({"paused": true}))
        .transact()
        .await
        .context("pause imported sandbox city")?;
    ensure!(pause.is_success(), "sandbox pause failed: {pause:?}");
    let paused_state = sandbox.view_state(&id).await.context("read paused state")?;
    let paused_account = sandbox
        .view_account(&id)
        .await
        .context("read paused account")?;
    let paused_root: LegacyRoot = borsh::from_slice(
        paused_state
            .get(b"STATE".as_slice())
            .context("paused root missing")?,
    )
    .context("decode paused legacy root")?;
    ensure!(paused_root.paused, "sandbox did not pause");
    ensure!(
        borsh_hash(&source_plots(&paused_state, 80).context("decode paused plots")?)?
            == live_plot_hash,
        "plot data changed during sandbox pause"
    );
    let deploy = copy
        .as_account()
        .deploy(&wasm)
        .await
        .context("deploy migration probe in sandbox")?;
    ensure!(deploy.is_success(), "migration probe deployment failed");
    let outsider = sandbox
        .dev_create_account()
        .await
        .context("create outsider test account")?;
    let outsider_attempt = outsider
        .call(&id, "migrate_city")
        .args_json(json!({
            "seeds": seeds,
            "moves": moves,
            "expected_config_version": paused_root.config.version,
            "expected_source_plot_hash": live_plot_hash,
            "expected_target_seed_hash": target_seed_hash,
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await
        .context("attempt unauthorized migration")?;
    ensure!(!outsider_attempt.is_success(), "outsider migrated the city");
    ensure!(
        sandbox.view_state(&id).await? == paused_state,
        "failed outsider call changed storage"
    );
    let wrong_hash = copy
        .as_account()
        .call(&id, "migrate_city")
        .args_json(json!({
            "seeds": seeds,
            "moves": moves,
            "expected_config_version": paused_root.config.version,
            "expected_source_plot_hash": "0".repeat(64),
            "expected_target_seed_hash": target_seed_hash,
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await
        .context("attempt migration with wrong source hash")?;
    ensure!(!wrong_hash.is_success(), "wrong source hash was accepted");
    ensure!(
        sandbox.view_state(&id).await? == paused_state,
        "failed hash guard changed storage"
    );
    let migration = copy
        .as_account()
        .call(&id, "migrate_city")
        .args_json(json!({
            "seeds": seeds,
            "moves": moves,
            "expected_config_version": paused_root.config.version,
            "expected_source_plot_hash": live_plot_hash,
            "expected_target_seed_hash": target_seed_hash,
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await
        .context("run local city conversion")?;
    ensure!(
        migration.is_success(),
        "sandbox conversion failed: {migration:?}"
    );
    let migrated_state = sandbox
        .view_state(&id)
        .await
        .context("read converted sandbox state")?;
    let migrated_account = sandbox
        .view_account(&id)
        .await
        .context("read converted sandbox account")?;
    let new_root: CityRootV2 = borsh::from_slice(
        migrated_state
            .get(b"STATE".as_slice())
            .context("converted root missing")?,
    )
    .context("decode converted city root")?;
    ensure!(
        new_root.city_version == 2
            && new_root.plot_count == 100
            && new_root.npc_site_count == 7
            && new_root.config.version == paused_root.config.version + 1,
        "converted root counts or version differ"
    );
    let mut curb_spaces = 0_u16;
    let mut converted_owned = 0_usize;
    for index in 0..new_root.plot_count {
        let plot_id: String = map_value(&migrated_state, b'I', &index)
            .with_context(|| format!("read converted plot index {index}"))?;
        let plot: near_estate_contract::PlotV2 = map_value(&migrated_state, b'P', &plot_id)
            .with_context(|| format!("decode converted plot {plot_id}"))?;
        ensure!(plot.id == plot_id, "converted plot index differs");
        curb_spaces += u16::from(plot.frontage_units);
        converted_owned += usize::from(plot.owner.is_some());
    }
    ensure!(curb_spaces == 180, "converted curb-space count differs");
    for (key, value) in &paused_state {
        if key.as_slice() != b"STATE" {
            ensure!(
                migrated_state.get(key) == Some(value),
                "legacy storage entry changed"
            );
        }
    }
    let source = source_plots(&paused_state, 80)?;
    let owned_count = source.iter().filter(|plot| plot.owner.is_some()).count();
    ensure!(
        new_root.deed_moves.len() == owned_count,
        "owned move count differs"
    );
    ensure!(converted_owned == owned_count, "owned plot count changed");
    for deed in &new_root.deed_moves {
        let old: Plot = map_value(&paused_state, b'p', &deed.from)?;
        let moved: near_estate_contract::PlotV2 = map_value(&migrated_state, b'P', &deed.to)?;
        ensure!(old.owner == moved.owner, "owner changed during move");
        ensure!(
            near_sdk::serde_json::to_value(&old.building)?
                == near_sdk::serde_json::to_value(&moved.building)?,
            "building state changed during move"
        );
        ensure!(
            near_sdk::serde_json::to_value(&old.logo)?
                == near_sdk::serde_json::to_value(&moved.logo)?,
            "logo state changed during move"
        );
        ensure!(
            near_sdk::serde_json::to_value(&old.billboard)?
                == near_sdk::serde_json::to_value(&moved.billboard)?,
            "billboard state changed during move"
        );
        ensure!(
            old.reserved_storage_bytes == moved.reserved_storage_bytes
                && old.used_storage_bytes == moved.used_storage_bytes,
            "storage reserve changed during move"
        );
    }
    let second = copy
        .as_account()
        .call(&id, "migrate_city")
        .args_json(json!({
            "seeds": seeds,
            "moves": moves,
            "expected_config_version": paused_root.config.version,
            "expected_source_plot_hash": live_plot_hash,
            "expected_target_seed_hash": target_seed_hash,
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(
        !second.is_success(),
        "second conversion unexpectedly succeeded"
    );
    ensure!(
        sandbox.view_state(&id).await? == migrated_state,
        "failed duplicate call changed storage"
    );
    let runtime_wasm = wasm.clone();
    let deploy_runtime = copy.as_account().deploy(&runtime_wasm).await?;
    ensure!(
        deploy_runtime.is_success(),
        "runtime WASM deployment failed"
    );
    let runtime_version: u8 = sandbox.view(&id, "city_version").await?.json()?;
    let runtime_plot_count: u16 = sandbox.view(&id, "plot_count").await?.json()?;
    ensure!(
        runtime_version == 2 && runtime_plot_count == 100,
        "runtime cannot read converted root"
    );
    let street: Value = sandbox
        .view(&id, "get_street_side")
        .args_json(json!({"road_id": "main", "side": "North"}))
        .await?
        .json()?;
    let street_plots = street["plots"]
        .as_array()
        .context("runtime street plots missing")?;
    ensure!(
        street_plots.len() == 10,
        "runtime street has wrong plot count"
    );
    for plot in street_plots {
        let width = plot["plot"]["plot"]["frontage_units"]
            .as_u64()
            .context("runtime plot width missing")?;
        ensure!(
            plot["slots"]
                .as_array()
                .context("runtime slots missing")?
                .len() as u64
                == width,
            "runtime slot count differs from frontage"
        );
    }
    let moved_main: Value = sandbox
        .view(&id, "get_plot")
        .args_json(json!({"plot_id": "plot-main-n-3"}))
        .await?
        .json()?;
    let mut carried_logos = 0_usize;
    for deed in &moves {
        let moved: Value = sandbox
            .view(&id, "get_plot")
            .args_json(json!({"plot_id": deed.to}))
            .await?
            .json()?;
        if moved["plot"]["logo"]["active"].is_object() {
            carried_logos += 1;
            ensure!(
                moved["logo_eligible"] == true,
                "old approved logo became ineligible after deed move to {}",
                deed.to
            );
        }
    }
    let carried_billboard_hidden = moved_main["plot"]["billboard"]["active"].is_object()
        && moved_main["plot"]["building"]["level"] == 2;
    if carried_billboard_hidden {
        ensure!(
            moved_main["billboard_eligible"] == false,
            "old approved billboard appears on a design without a level-2 surface"
        );
    }
    let unowned_narrow = seeds
        .iter()
        .find(|seed| seed.frontage_units == 1 && seed.index > 0 && seed.index < 9)
        .context("no noncorner 1-unit plot")?;
    let unowned_wide = seeds
        .iter()
        .find(|seed| seed.frontage_units == 3 && seed.index > 0 && seed.index < 9)
        .context("no noncorner 3-unit plot")?;
    let unowned_standard = seeds
        .iter()
        .find(|seed| {
            seed.frontage_units == 2
                && seed.index > 0
                && seed.index < 9
                && !moves.iter().any(|deed| deed.to == seed.id())
        })
        .context("no unowned noncorner 2-unit plot")?;
    for (seed, expected_price) in [
        (unowned_narrow, "500000000000000000000000"),
        (unowned_wide, "1500000000000000000000000"),
    ] {
        let quote: Value = sandbox
            .view(&id, "plot_purchase_breakdown")
            .args_json(json!({"plot_id": seed.id()}))
            .await?
            .json()?;
        ensure!(
            quote["price_yocto"] == expected_price,
            "runtime plot price differs from unit frontage"
        );
    }
    ensure!(
        sandbox.view_state(&id).await? == migrated_state,
        "runtime read views changed migrated storage"
    );
    let reverse_wasm = build_feature(&target_dir, "reverse")?;
    let deploy_reverse = copy.as_account().deploy(&reverse_wasm).await?;
    ensure!(
        deploy_reverse.is_success(),
        "reverse WASM deployment failed"
    );
    let outsider_reverse = outsider.call(&id, "reverse_city").transact().await?;
    ensure!(!outsider_reverse.is_success(), "outsider reversed the city");
    ensure!(
        sandbox.view_state(&id).await? == migrated_state,
        "failed outsider reverse changed storage"
    );
    let reversed = copy
        .as_account()
        .call(&id, "reverse_city")
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(
        reversed.is_success(),
        "sandbox reverse failed: {reversed:?}"
    );
    let reversed_state = sandbox.view_state(&id).await?;
    ensure!(
        reversed_state == paused_state,
        "reverse did not restore exact V1 storage"
    );
    let restore_old_code = copy.as_account().deploy(&old_wasm).await?;
    ensure!(restore_old_code.is_success(), "old WASM restore failed");
    ensure!(
        hash(&sandbox.view_code(&id).await?) == expected_code_hash,
        "restored code differs from live code"
    );
    let restored_count: u16 = sandbox.view(&id, "plot_count").await?.json()?;
    ensure!(restored_count == 80, "old code cannot read restored root");
    ensure!(
        sandbox.view_state(&id).await? == paused_state,
        "old code restore changed storage"
    );
    // A fresh sandbox-only forward pass checks that the playable runtime can
    // use the migrated state. This happens after the exact rollback proof.
    let redeploy_forward = copy.as_account().deploy(&wasm).await?;
    ensure!(
        redeploy_forward.is_success(),
        "second forward WASM deployment failed"
    );
    let re_migration = copy
        .as_account()
        .call(&id, "migrate_city")
        .args_json(json!({
            "seeds": seeds,
            "moves": moves,
            "expected_config_version": paused_root.config.version,
            "expected_source_plot_hash": live_plot_hash,
            "expected_target_seed_hash": target_seed_hash,
        }))
        .gas(Gas::from_tgas(300))
        .transact()
        .await?;
    ensure!(
        re_migration.is_success(),
        "runtime fixture conversion failed"
    );
    let redeploy_runtime = copy.as_account().deploy(&runtime_wasm).await?;
    ensure!(redeploy_runtime.is_success(), "runtime deployment failed");
    let unpause = copy
        .as_account()
        .call(&id, "set_paused")
        .args_json(json!({"paused": false}))
        .transact()
        .await?;
    ensure!(unpause.is_success(), "sandbox runtime unpause failed");
    let buyer = sandbox.dev_create_account().await?;
    let registration_quote: String = sandbox.view(&id, "registration_quote").await?.json()?;
    let registered = buyer
        .call(&id, "register_player")
        .args_json(json!({"body": "Sedan", "color": "Blue"}))
        .deposit(NearToken::from_yoctonear(registration_quote.parse()?))
        .transact()
        .await?;
    ensure!(
        registered.is_success(),
        "runtime player registration failed: {registered:?}"
    );
    let driver = sandbox.dev_create_account().await?;
    let driver_registration = driver
        .call(&id, "register_player")
        .args_json(json!({"body": "Hatchback", "color": "Red"}))
        .deposit(NearToken::from_yoctonear(registration_quote.parse()?))
        .transact()
        .await?;
    ensure!(
        driver_registration.is_success(),
        "runtime driver registration failed"
    );
    let driver_car: Value = driver_registration.json()?;
    let driver_car_id = driver_car["id"].as_u64().context("driver car ID missing")?;
    let gameplay_secret = SecretKey::from_random(KeyType::ED25519);
    let gameplay_public = gameplay_secret.public_key();
    let added_gameplay_key = driver
        .batch(driver.id())
        .add_key(
            gameplay_public.clone(),
            AccessKey::function_call_access(
                &id,
                &GAMEPLAY_METHODS,
                Some(NearToken::from_yoctonear(GAMEPLAY_ALLOWANCE_YOCTO)),
            ),
        )
        .transact()
        .await?;
    ensure!(
        added_gameplay_key.is_success(),
        "runtime gameplay key creation failed"
    );
    let access = driver.view_access_key(&gameplay_public).await?;
    let AccessKeyPermission::FunctionCall(permission) = access.permission else {
        anyhow::bail!("runtime gameplay key became full access");
    };
    ensure!(
        permission.receiver_id == id.as_str(),
        "runtime gameplay key receiver differs"
    );
    ensure!(
        permission.method_names == GAMEPLAY_METHODS,
        "runtime gameplay key methods differ"
    );
    ensure!(
        permission.allowance.map(|value| value.as_yoctonear()) == Some(GAMEPLAY_ALLOWANCE_YOCTO),
        "runtime gameplay key allowance differs"
    );
    let restricted_driver =
        Account::from_secret_key(driver.id().clone(), gameplay_secret, &sandbox);
    let forbidden_purchase = restricted_driver
        .call(&id, "buy_car")
        .args_json(json!({"body": "Sedan", "color": "Blue"}))
        .transact()
        .await;
    ensure!(
        !matches!(forbidden_purchase, Ok(ref outcome) if outcome.is_success()),
        "runtime gameplay key bought a car"
    );
    let wide_quote: Value = sandbox
        .view(&id, "plot_purchase_breakdown")
        .args_json(json!({"plot_id": unowned_wide.id()}))
        .await?
        .json()?;
    let total_yocto: u128 = wide_quote["total_yocto"]
        .as_str()
        .context("wide plot total quote missing")?
        .parse()?;
    let purchased = buyer
        .call(&id, "buy_plot")
        .args_json(json!({"plot_id": unowned_wide.id()}))
        .deposit(NearToken::from_yoctonear(total_yocto))
        .transact()
        .await?;
    ensure!(
        purchased.is_success(),
        "runtime three-unit purchase failed: {purchased:?}"
    );
    let purchased_wide: Value = purchased.json()?;
    let wide_used = purchased_wide["used_storage_bytes"]
        .as_u64()
        .context("three-unit plot storage usage missing")?;
    let scheduled = buyer
        .call(&id, "set_rule")
        .args_json(json!({"plot_id": unowned_wide.id(), "rule": {"kind": "NoParking"}}))
        .transact()
        .await?;
    ensure!(
        scheduled.is_success(),
        "runtime rule schedule failed: {scheduled:?}"
    );
    let owned_plot: Value = sandbox
        .view(&id, "get_plot")
        .args_json(json!({"plot_id": unowned_wide.id()}))
        .await?
        .json()?;
    ensure!(
        owned_plot["plot"]["owner"] == buyer.id().as_str(),
        "runtime owner differs"
    );
    ensure!(
        owned_plot["plot"]["frontage_units"] == 3,
        "runtime plot width differs"
    );
    ensure!(
        owned_plot["plot"]["pending_rule"]["rule"]["kind"] == "NoParking",
        "runtime delayed rule missing"
    );
    let parked_before_rule = restricted_driver
        .call(&id, "park")
        .args_json(json!({"car_id": driver_car_id, "plot_id": unowned_wide.id(), "slot": 2}))
        .transact()
        .await?;
    ensure!(parked_before_rule.is_success(), "pre-rule parking failed");
    let pre_rule_session: Value = parked_before_rule.json()?;
    ensure!(
        pre_rule_session["legal"] == true,
        "pending rule applied too early"
    );
    sandbox.fast_forward(1_200).await?;
    let parked_after_rule: Value = sandbox
        .view(&id, "get_session")
        .args_json(json!({"session_id": pre_rule_session["id"]}))
        .await?
        .json()?;
    ensure!(
        parked_after_rule["legal"] == true,
        "rule change made an existing park illegal"
    );
    let pre_rule_collect = restricted_driver
        .call(&id, "collect")
        .args_json(json!({"expected_session_id": pre_rule_session["id"]}))
        .transact()
        .await?;
    ensure!(pre_rule_collect.is_success(), "pre-rule collect failed");
    let removed_gameplay_key = driver
        .batch(driver.id())
        .delete_key(gameplay_public.clone())
        .transact()
        .await?;
    ensure!(
        removed_gameplay_key.is_success(),
        "runtime gameplay key removal failed"
    );
    ensure!(
        driver
            .view_access_keys()
            .await?
            .iter()
            .all(|entry| entry.public_key != gameplay_public),
        "runtime gameplay key remains after removal"
    );
    let invalid_slot = driver
        .call(&id, "park")
        .args_json(json!({"car_id": driver_car_id, "plot_id": unowned_narrow.id(), "slot": 1}))
        .transact()
        .await?;
    ensure!(
        !invalid_slot.is_success(),
        "one-unit plot accepted a second slot"
    );
    let legal_park = driver
        .call(&id, "park")
        .args_json(json!({"car_id": driver_car_id, "plot_id": unowned_narrow.id(), "slot": 0}))
        .transact()
        .await?;
    ensure!(
        legal_park.is_success(),
        "runtime one-unit park failed: {legal_park:?}"
    );
    let legal_session: Value = legal_park.json()?;
    ensure!(legal_session["legal"] == true, "free curb was not legal");
    sandbox.fast_forward(1_200).await?;
    let collected = driver
        .call(&id, "collect")
        .args_json(json!({"expected_session_id": legal_session["id"]}))
        .transact()
        .await?;
    ensure!(
        collected.is_success(),
        "runtime collect failed: {collected:?}"
    );
    let illegal_park = driver
        .call(&id, "park")
        .args_json(json!({"car_id": driver_car_id, "plot_id": unowned_wide.id(), "slot": 2}))
        .transact()
        .await?;
    ensure!(
        illegal_park.is_success(),
        "runtime three-unit park failed: {illegal_park:?}"
    );
    let illegal_session: Value = illegal_park.json()?;
    ensure!(
        illegal_session["legal"] == false,
        "delayed rule was not active"
    );
    let outsider_inspect = driver
        .call(&id, "inspect")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "slot": 2,
            "expected_session_id": illegal_session["id"]
        }))
        .transact()
        .await?;
    ensure!(
        !outsider_inspect.is_success(),
        "ordinary player inspected a car"
    );
    let ticketed = buyer
        .call(&id, "ticket")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "slot": 2,
            "expected_session_id": illegal_session["id"]
        }))
        .transact()
        .await?;
    ensure!(
        ticketed.is_success(),
        "runtime three-unit ticket failed: {ticketed:?}"
    );
    let ticket_result: Value = ticketed.json()?;
    ensure!(
        ticket_result["session_id"] == illegal_session["id"],
        "ticketed wrong session"
    );
    let repair = driver
        .call(&id, "repair")
        .args_json(json!({"car_id": driver_car_id, "points": 6}))
        .transact()
        .await?;
    ensure!(repair.is_success(), "runtime car repair failed: {repair:?}");
    let repaired_car: Value = repair.json()?;
    ensure!(
        repaired_car["durability"] == 100,
        "repair did not restore durability"
    );
    let cosmetic = driver.call(&id, "buy_cosmetic").transact().await?;
    ensure!(cosmetic.is_success(), "runtime cosmetic purchase failed");
    let mut cheap_config: Value = sandbox.view(&id, "get_config").await?.json()?;
    let old_version = cheap_config["version"]
        .as_u64()
        .context("config version missing")?;
    cheap_config["version"] = json!(old_version + 1);
    cheap_config["buy_car_cost"] = json!("1000000");
    cheap_config["tier_upgrade_costs"] = json!(["1000000", "2000000"]);
    cheap_config["inspector_chance_bps"] = json!(10_000);
    cheap_config["change_building_type_cost"] = json!("1000000");
    cheap_config["building_upgrade_costs"] = json!(["1000000", "2000000", "3000000"]);
    cheap_config["facade_cooldown_seconds"] = json!(0);
    cheap_config["logo_cooldown_seconds"] = json!(0);
    let configured = copy
        .as_account()
        .call(&id, "update_config")
        .args_json(json!({"config": cheap_config}))
        .transact()
        .await?;
    ensure!(
        configured.is_success(),
        "runtime config update failed: {configured:?}"
    );
    let mut purchased_car_id = None;
    for body in ["Sedan", "SUV"] {
        let bought_car = driver
            .call(&id, "buy_car")
            .args_json(json!({"body": body, "color": "Blue"}))
            .transact()
            .await?;
        ensure!(
            bought_car.is_success(),
            "runtime car purchase failed: {bought_car:?}"
        );
        let car: Value = bought_car.json()?;
        purchased_car_id = car["id"].as_u64();
    }
    let fourth_car = driver
        .call(&id, "buy_car")
        .args_json(json!({"body": "Pickup", "color": "Green"}))
        .transact()
        .await?;
    ensure!(!fourth_car.is_success(), "runtime accepted fourth car");
    let upgraded = driver
        .call(&id, "upgrade_car")
        .args_json(json!({"car_id": purchased_car_id.context("purchased car ID missing")?}))
        .transact()
        .await?;
    ensure!(
        upgraded.is_success(),
        "runtime car upgrade failed: {upgraded:?}"
    );
    let upgraded_car: Value = upgraded.json()?;
    ensure!(
        upgraded_car["tier"] == 2,
        "runtime car tier did not advance"
    );
    let outsider_preset = driver
        .call(&id, "choose_preset")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "variant": 2,
            "primary_color": "#EF8270", "name": "Harbor Studio"
        }))
        .transact()
        .await?;
    ensure!(!outsider_preset.is_success(), "nonowner changed building");
    let chosen = buyer
        .call(&id, "choose_preset")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "variant": 2,
            "primary_color": "#EF8270", "name": "Harbor Studio"
        }))
        .transact()
        .await?;
    ensure!(
        chosen.is_success(),
        "runtime owner preset failed: {chosen:?}"
    );
    let chosen_plot: Value = chosen.json()?;
    ensure!(
        chosen_plot["building"]["name"] == "Harbor Studio",
        "owner building name differs"
    );
    let initial_design = chosen_plot["design_choice"]
        .as_u64()
        .context("initial design choice missing")?;
    ensure!(initial_design < 5, "initial design is outside the catalog");
    let next_design = (initial_design + 1) % 5;
    let outsider_design = driver
        .call(&id, "choose_design")
        .args_json(json!({"plot_id": unowned_wide.id(), "choice": next_design}))
        .transact()
        .await?;
    ensure!(
        !outsider_design.is_success(),
        "nonowner changed building design"
    );
    let chosen_design = buyer
        .call(&id, "choose_design")
        .args_json(json!({"plot_id": unowned_wide.id(), "choice": next_design}))
        .transact()
        .await?;
    ensure!(chosen_design.is_success(), "runtime design choice failed");
    let designed_plot: Value = chosen_design.json()?;
    ensure!(
        designed_plot["design_choice"] == next_design,
        "owner design choice did not persist"
    );
    ensure!(
        designed_plot["frontage_units"] == 3,
        "design choice changed plot width"
    );
    let current_type = chosen_plot["building"]["building_type"]
        .as_str()
        .context("building type missing")?;
    let next_type = if current_type == "Retail" {
        "Cafe"
    } else {
        "Retail"
    };
    let changed_type = buyer
        .call(&id, "change_building_type")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "building_type": next_type, "variant": 1
        }))
        .transact()
        .await?;
    ensure!(
        changed_type.is_success(),
        "runtime building type change failed"
    );
    let upgraded_building = buyer
        .call(&id, "upgrade_building")
        .args_json(json!({"plot_id": unowned_wide.id()}))
        .transact()
        .await?;
    ensure!(
        upgraded_building.is_success(),
        "runtime building upgrade failed"
    );
    let upgraded_plot: Value = upgraded_building.json()?;
    ensure!(
        upgraded_plot["building"]["level"] == 2,
        "building level differs"
    );
    ensure!(
        upgraded_plot["building"]["layout_revision"].as_u64()
            > owned_plot["plot"]["building"]["layout_revision"].as_u64(),
        "building layout revision did not advance"
    );
    let art_fixture: Value = near_sdk::serde_json::from_slice(&std::fs::read(
        root().join("tests/fixtures/variable-city-media/fixture.json"),
    )?)?;
    ensure!(
        art_fixture["manifest"]["frontageUnits"] == upgraded_plot["frontage_units"]
            && art_fixture["manifest"]["designChoice"] == upgraded_plot["design_choice"]
            && art_fixture["manifest"]["buildingType"]
                == upgraded_plot["building"]["building_type"]
            && art_fixture["manifest"]["level"] == upgraded_plot["building"]["level"],
        "local art fixture does not match the sandbox plot"
    );
    for field in ["spriteHash", "thumbnailHash"] {
        let asset_hash = art_fixture[field]
            .as_str()
            .with_context(|| format!("{field} missing from local art fixture"))?;
        let asset = std::fs::read(root().join(format!(
            "tests/fixtures/variable-city-media/{asset_hash}.png"
        )))?;
        ensure!(hash(&asset) == asset_hash, "local art asset hash differs");
    }
    let roles: (AccountId, AccountId, AccountId) = sandbox.view(&id, "get_roles").await?.json()?;
    let testnet_parent = sandbox
        .create_tla(
            "testnet".parse()?,
            SecretKey::from_seed(KeyType::ED25519, "sandbox-only-testnet-parent"),
        )
        .await?
        .into_result()?;
    let inspector_label = roles
        .2
        .as_str()
        .strip_suffix(".testnet")
        .context("imported inspector is not a testnet subaccount")?;
    let inspector = testnet_parent
        .create_subaccount(inspector_label)
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let moderator_label = roles
        .1
        .as_str()
        .strip_suffix(".testnet")
        .context("imported moderator is not a testnet subaccount")?;
    let moderator = testnet_parent
        .create_subaccount(moderator_label)
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let manifest_hash = art_fixture["manifestHash"]
        .as_str()
        .context("local art manifest hash missing")?
        .to_string();
    let proposed_appearance = buyer
        .call(&id, "propose_appearance")
        .args_json(json!({
            "plot_id": unowned_wide.id(),
            "expected_revision": upgraded_plot["building"]["appearance_revision"],
            "manifest_hash": manifest_hash
        }))
        .transact()
        .await?;
    ensure!(
        proposed_appearance.is_success(),
        "runtime facade proposal failed"
    );
    let appearance_reference: Value = proposed_appearance.json()?;
    let pending_facade_view: Value = sandbox
        .view(&id, "get_plot")
        .args_json(json!({"plot_id": unowned_wide.id()}))
        .await?
        .json()?;
    ensure!(
        pending_facade_view["plot"]["building"]["pending_appearance"] == appearance_reference,
        "pending facade view differs from proposal"
    );
    let outsider_appearance = driver
        .call(&id, "approve_appearance")
        .args_json(json!({"plot_id": unowned_wide.id(), "expected": appearance_reference}))
        .transact()
        .await?;
    ensure!(
        !outsider_appearance.is_success(),
        "nonmoderator approved facade"
    );
    let approved_appearance = moderator
        .call(&id, "approve_appearance")
        .args_json(json!({"plot_id": unowned_wide.id(), "expected": appearance_reference}))
        .transact()
        .await?;
    ensure!(
        approved_appearance.is_success(),
        "runtime facade approval failed"
    );
    let facade_plot: Value = approved_appearance.json()?;
    ensure!(
        facade_plot["building"]["approved_manifest_hash"] == manifest_hash,
        "facade approval did not persist"
    );
    let approved_facade_view: Value = sandbox
        .view(&id, "get_plot")
        .args_json(json!({"plot_id": unowned_wide.id()}))
        .await?
        .json()?;
    ensure!(
        approved_facade_view["plot"]["building"]["approved_manifest_hash"] == manifest_hash
            && approved_facade_view["plot"]["building"]["last_appearance_decision"]["reference"]
                == appearance_reference,
        "approved facade view differs from moderation decision"
    );
    let logo_hash = art_fixture["logoHash"]
        .as_str()
        .context("local logo hash missing")?
        .to_string();
    let logo_png = std::fs::read(root().join(format!(
        "tests/fixtures/variable-city-media/{logo_hash}.png"
    )))?;
    ensure!(
        hash(&logo_png) == logo_hash,
        "local logo asset hash differs"
    );
    let proposed_logo = buyer
        .call(&id, "propose_media")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "kind": "Logo",
            "expected_media_revision": facade_plot["logo"]["revision"],
            "expected_layout_revision": facade_plot["building"]["layout_revision"],
            "content": {"asset_hash": logo_hash, "link": "https://near.org"}
        }))
        .transact()
        .await?;
    ensure!(proposed_logo.is_success(), "runtime logo proposal failed");
    let logo_proposal: Value = proposed_logo.json()?;
    let approved_logo = moderator
        .call(&id, "approve_media")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "kind": "Logo", "expected": logo_proposal
        }))
        .transact()
        .await?;
    ensure!(approved_logo.is_success(), "runtime logo approval failed");
    let media_view: Value = approved_logo.json()?;
    ensure!(
        media_view["logo_eligible"] == true,
        "approved logo is not eligible"
    );
    let approved_logo_view: Value = sandbox
        .view(&id, "get_plot")
        .args_json(json!({"plot_id": unowned_wide.id()}))
        .await?
        .json()?;
    ensure!(
        approved_logo_view["logo_eligible"] == true
            && approved_logo_view["plot"]["logo"]["active"]["content"]["asset_hash"] == logo_hash,
        "approved logo view differs from moderation decision"
    );
    let changed_design_after_approval = buyer
        .call(&id, "choose_design")
        .args_json(json!({"plot_id": unowned_wide.id(), "choice": initial_design}))
        .transact()
        .await?;
    ensure!(
        changed_design_after_approval.is_success(),
        "design change after media approval failed"
    );
    let stale_media_view: Value = sandbox
        .view(&id, "get_plot")
        .args_json(json!({"plot_id": unowned_wide.id()}))
        .await?
        .json()?;
    ensure!(
        stale_media_view["logo_eligible"] == false
            && stale_media_view["plot"]["building"]["approved_manifest_hash"].is_null(),
        "design change left old facade or logo eligible"
    );
    let removed_logo = buyer
        .call(&id, "remove_media")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "kind": "Logo",
            "expected_media_revision": stale_media_view["plot"]["logo"]["revision"]
        }))
        .transact()
        .await?;
    ensure!(
        removed_logo.is_success(),
        "runtime owner logo removal failed"
    );
    let after_logo_removal: Value = removed_logo.json()?;
    ensure!(
        after_logo_removal["plot"]["logo"]["active"].is_null(),
        "owner logo removal retained active image"
    );
    let rejected_billboard_proposal = buyer
        .call(&id, "propose_media")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "kind": "Billboard",
            "expected_media_revision": after_logo_removal["plot"]["billboard"]["revision"],
            "expected_layout_revision": after_logo_removal["plot"]["building"]["layout_revision"],
            "content": {"asset_hash": "e".repeat(64), "link": null}
        }))
        .transact()
        .await?;
    ensure!(
        rejected_billboard_proposal.is_success(),
        "billboard proposal failed"
    );
    let rejected_proposal: Value = rejected_billboard_proposal.json()?;
    let rejected_billboard = moderator
        .call(&id, "reject_media")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "kind": "Billboard",
            "expected": rejected_proposal, "reason": "Needs clearer art"
        }))
        .transact()
        .await?;
    ensure!(
        rejected_billboard.is_success(),
        "billboard rejection failed"
    );
    let rejected_view: Value = rejected_billboard.json()?;
    ensure!(
        rejected_view["plot"]["billboard"]["last_decision"]["status"] == "Rejected",
        "billboard rejection was not recorded"
    );
    let billboard_content = json!({"asset_hash": "f".repeat(64), "link": null});
    let approved_billboard_proposal = buyer
        .call(&id, "propose_media")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "kind": "Billboard",
            "expected_media_revision": rejected_view["plot"]["billboard"]["revision"],
            "expected_layout_revision": rejected_view["plot"]["building"]["layout_revision"],
            "content": billboard_content
        }))
        .transact()
        .await?;
    ensure!(
        approved_billboard_proposal.is_success(),
        "second billboard proposal failed"
    );
    let approved_billboard_reference: Value = approved_billboard_proposal.json()?;
    let approved_billboard = moderator
        .call(&id, "approve_media")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "kind": "Billboard",
            "expected": approved_billboard_reference
        }))
        .transact()
        .await?;
    ensure!(approved_billboard.is_success(), "billboard approval failed");
    let approved_billboard_view: Value = approved_billboard.json()?;
    ensure!(
        approved_billboard_view["plot"]["billboard"]["active"].is_object()
            && approved_billboard_view["billboard_eligible"] == false,
        "unsupported approved billboard appeared on the three-unit facade"
    );
    let revoked_billboard = moderator
        .call(&id, "revoke_media")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "kind": "Billboard",
            "expected_media_revision": approved_billboard_view["plot"]["billboard"]["revision"],
            "expected_content": billboard_content, "reason": "Ad retired"
        }))
        .transact()
        .await?;
    ensure!(
        revoked_billboard.is_success(),
        "billboard revocation failed"
    );
    let revoked_billboard_view: Value = revoked_billboard.json()?;
    ensure!(
        revoked_billboard_view["billboard_eligible"] == false,
        "revoked billboard remained eligible"
    );
    let rejected_facade_proposal = buyer
        .call(&id, "propose_appearance")
        .args_json(json!({
            "plot_id": unowned_wide.id(),
            "expected_revision": revoked_billboard_view["plot"]["building"]["appearance_revision"],
            "manifest_hash": "1".repeat(64)
        }))
        .transact()
        .await?;
    ensure!(
        rejected_facade_proposal.is_success(),
        "second facade proposal failed"
    );
    let rejected_facade_reference: Value = rejected_facade_proposal.json()?;
    let rejected_facade = moderator
        .call(&id, "reject_appearance")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "expected": rejected_facade_reference,
            "reason": "Too much detail"
        }))
        .transact()
        .await?;
    ensure!(rejected_facade.is_success(), "facade rejection failed");
    let rejected_facade_plot: Value = rejected_facade.json()?;
    ensure!(
        rejected_facade_plot["building"]["last_appearance_decision"]["status"] == "Rejected",
        "facade rejection was not recorded"
    );
    let replacement_manifest = "2".repeat(64);
    let replacement_facade_proposal = buyer
        .call(&id, "propose_appearance")
        .args_json(json!({
            "plot_id": unowned_wide.id(),
            "expected_revision": rejected_facade_plot["building"]["appearance_revision"],
            "manifest_hash": replacement_manifest
        }))
        .transact()
        .await?;
    ensure!(
        replacement_facade_proposal.is_success(),
        "replacement facade proposal failed"
    );
    let replacement_reference: Value = replacement_facade_proposal.json()?;
    let replacement_approval = moderator
        .call(&id, "approve_appearance")
        .args_json(json!({"plot_id": unowned_wide.id(), "expected": replacement_reference}))
        .transact()
        .await?;
    ensure!(
        replacement_approval.is_success(),
        "replacement facade approval failed"
    );
    let replacement_plot: Value = replacement_approval.json()?;
    let revoked_facade = moderator
        .call(&id, "revoke_appearance")
        .args_json(json!({
            "plot_id": unowned_wide.id(),
            "expected_revision": replacement_plot["building"]["appearance_revision"],
            "expected_manifest_hash": replacement_manifest,
            "reason": "Retired design"
        }))
        .transact()
        .await?;
    ensure!(revoked_facade.is_success(), "facade revocation failed");
    let revoked_facade_plot: Value = revoked_facade.json()?;
    ensure!(
        revoked_facade_plot["building"]["approved_manifest_hash"].is_null(),
        "revoked facade remained approved"
    );
    let second_illegal_park = driver
        .call(&id, "park")
        .args_json(json!({"car_id": driver_car_id, "plot_id": unowned_wide.id(), "slot": 1}))
        .transact()
        .await?;
    ensure!(
        second_illegal_park.is_success(),
        "runtime inspector fixture park failed"
    );
    let second_illegal_session: Value = second_illegal_park.json()?;
    let cooldown_ticket = buyer
        .call(&id, "ticket")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "slot": 1,
            "expected_session_id": second_illegal_session["id"]
        }))
        .transact()
        .await?;
    ensure!(
        !cooldown_ticket.is_success(),
        "owner ticket ignored cooldown"
    );
    sandbox.fast_forward(1_200).await?;
    let treasury_before: String = sandbox.view(&id, "get_treasury_coins").await?.json()?;
    let inspected = inspector
        .call(&id, "inspect")
        .args_json(json!({
            "plot_id": unowned_wide.id(), "slot": 1,
            "expected_session_id": second_illegal_session["id"]
        }))
        .transact()
        .await?;
    ensure!(
        inspected.is_success(),
        "runtime inspector call failed: {inspected:?}"
    );
    let inspection_result: Value = inspected.json()?;
    ensure!(
        inspection_result["session_id"] == second_illegal_session["id"],
        "inspector did not settle expected session"
    );
    let treasury_after: String = sandbox.view(&id, "get_treasury_coins").await?.json()?;
    ensure!(
        treasury_after.parse::<u128>()? > treasury_before.parse::<u128>()?,
        "inspector payout did not reach treasury"
    );
    let npc_sites: Vec<Value> = sandbox
        .view(&id, "get_npc_sites")
        .args_json(json!({"from_index": 0, "limit": 10}))
        .await?
        .json()?;
    let tower_id = npc_sites
        .iter()
        .find(|site| site["role"] == "ParkingTower")
        .and_then(|site| site["id"].as_str())
        .context("sandbox parking tower missing")?;
    let tower_open_before: u8 = sandbox
        .view(&id, "get_tower_availability")
        .args_json(json!({"site_id": tower_id}))
        .await?
        .json()?;
    ensure!(tower_open_before == 32, "empty tower capacity differs");
    let tower_park = driver
        .call(&id, "park_tower")
        .args_json(json!({"car_id": driver_car_id, "site_id": tower_id, "space": 0}))
        .transact()
        .await?;
    ensure!(
        tower_park.is_success(),
        "runtime tower park failed: {tower_park:?}"
    );
    let tower_session: Value = tower_park.json()?;
    ensure!(
        tower_session["facility"] == "Tower",
        "tower session facility differs"
    );
    let tower_open_during: u8 = sandbox
        .view(&id, "get_tower_availability")
        .args_json(json!({"site_id": tower_id}))
        .await?
        .json()?;
    ensure!(tower_open_during == 31, "tower occupancy count differs");
    let tower_first_open: u8 = sandbox
        .view(&id, "get_tower_open_space")
        .args_json(json!({"site_id": tower_id}))
        .await?
        .json()?;
    ensure!(tower_first_open == 1, "tower open-space view differs");
    let floor_availability: Vec<u8> = sandbox
        .view(&id, "get_tower_floor_availability")
        .args_json(json!({"site_id": tower_id}))
        .await?
        .json()?;
    ensure!(
        floor_availability == vec![7, 8, 8, 8],
        "tower floor availability differs"
    );
    let first_open: u8 = sandbox
        .view(&id, "get_tower_open_space_on_floor")
        .args_json(json!({"site_id": tower_id, "floor": 0}))
        .await?
        .json()?;
    ensure!(first_open == 1, "tower floor did not skip occupied space");
    let floor_sessions: Vec<Option<Value>> = sandbox
        .view(&id, "get_tower_floor_sessions")
        .args_json(json!({"site_id": tower_id, "floor": 0}))
        .await?
        .json()?;
    ensure!(
        floor_sessions.len() == 8 && floor_sessions[0].is_some(),
        "tower floor session view differs"
    );
    let tower_collect = driver
        .call(&id, "collect")
        .args_json(json!({"expected_session_id": tower_session["id"]}))
        .transact()
        .await?;
    ensure!(tower_collect.is_success(), "runtime tower collect failed");
    let tower_open_after: u8 = sandbox
        .view(&id, "get_tower_availability")
        .args_json(json!({"site_id": tower_id}))
        .await?
        .json()?;
    ensure!(tower_open_after == 32, "tower space did not reopen");
    let mut plot_storage_by_frontage = vec![json!({
        "units": 3,
        "plotId": unowned_wide.id(),
        "usedBytes": wide_used,
    })];
    for seed in [unowned_narrow, unowned_standard] {
        let quote: Value = sandbox
            .view(&id, "plot_purchase_breakdown")
            .args_json(json!({"plot_id": seed.id()}))
            .await?
            .json()?;
        ensure!(
            quote["storage_reserve_yocto"] == wide_quote["storage_reserve_yocto"],
            "plot storage quote changed with frontage width"
        );
        let total: u128 = quote["total_yocto"]
            .as_str()
            .context("plot storage measurement quote missing")?
            .parse()?;
        let purchase = buyer
            .call(&id, "buy_plot")
            .args_json(json!({"plot_id": seed.id()}))
            .deposit(NearToken::from_yoctonear(total))
            .transact()
            .await?;
        ensure!(
            purchase.is_success(),
            "plot storage measurement purchase failed: {purchase:?}"
        );
        let plot: Value = purchase.json()?;
        let used = plot["used_storage_bytes"]
            .as_u64()
            .context("plot storage usage missing")?;
        ensure!(
            used == wide_used,
            "plot storage use changed with frontage width"
        );
        plot_storage_by_frontage.push(json!({
            "units": seed.frontage_units,
            "plotId": seed.id(),
            "usedBytes": used,
        }));
    }
    let runtime_action_state = sandbox.view_state(&id).await?;
    // The reverse-feature build uses the same output filename. Leave the
    // forward binary there so a second rehearsal starts with the right code.
    std::fs::write(&migration_wasm_path, &wasm)?;
    let evidence = json!({
        "scope": "live testnet state imported into an isolated local sandbox; no live mutation",
        "contractId": id,
        "liveCodeSha256": expected_code_hash,
        "migrationWasmSha256": hash(&wasm),
        "runtimeWasmSha256": hash(&runtime_wasm),
        "reverseWasmSha256": hash(&reverse_wasm),
        "liveStateSha256": state_hash(&live_state),
        "pausedSandboxStateSha256": state_hash(&paused_state),
        "convertedSandboxStateSha256": state_hash(&migrated_state),
        "reversedSandboxStateSha256": state_hash(&reversed_state),
        "runtimeActionSandboxStateSha256": state_hash(&runtime_action_state),
        "sourcePlotHash": live_plot_hash,
        "targetSeedHash": target_seed_hash,
        "oldPlots": 80,
        "newPlots": new_root.plot_count,
        "newCurbSpaces": curb_spaces,
        "civicSites": new_root.npc_site_count,
        "ownedDeeds": owned_count,
        "moves": moves,
        "oldConfigVersion": paused_root.config.version,
        "newConfigVersion": new_root.config.version,
        "storageBytesBefore": paused_account.storage_usage,
        "storageBytesAfter": migrated_account.storage_usage,
        "plotStorageByFrontage": plot_storage_by_frontage,
        "gasBurnt": migration.total_gas_burnt.as_gas().to_string(),
        "reverseGasBurnt": reversed.total_gas_burnt.as_gas().to_string(),
        "outsiderRejected": true,
        "wrongHashRejected": true,
        "duplicateRejected": true,
        "legacyMapBytesPreserved": true,
        "runtimeReadViewsVerified": true,
        "runtimeRegistrationVerified": true,
        "runtimeGameplayKeyMethodsVerified": true,
        "runtimeRestrictedParkingVerified": true,
        "runtimeForbiddenPurchaseDenied": true,
        "runtimeGameplayKeyRevoked": true,
        "runtimeThreeUnitPurchaseVerified": true,
        "runtimeRuleDelayVerified": true,
        "runtimeParkTimeLegalityVerified": true,
        "runtimeVariableSlotParkingVerified": true,
        "runtimeCarriedBillboardHiddenVerified": carried_billboard_hidden,
        "runtimeCarriedLogosEligibleVerified": true,
        "runtimeCarriedLogoCount": carried_logos,
        "runtimeCollectVerified": true,
        "runtimeThreeUnitTicketVerified": true,
        "runtimeInspectorRoleDenied": true,
        "runtimeInspectorTreasuryVerified": true,
        "runtimeTicketCooldownVerified": true,
        "runtimeTowerParkingVerified": true,
        "runtimeTowerViewsVerified": true,
        "runtimeGarageActionsVerified": true,
        "runtimeOwnerBuildingActionsVerified": true,
        "runtimeFiveDesignChoicesVerified": true,
        "runtimeAppearanceApprovalVerified": true,
        "runtimeLogoApprovalVerified": true,
        "runtimeDesignMediaInvalidationVerified": true,
        "runtimeModerationDecisionsVerified": true,
        "exactStorageRollback": true,
        "oldCodeRestored": true,
    });
    let evidence_path = root().join("deployments/variable-city-sandbox-rehearsal-2026-11-12.json");
    std::fs::write(
        &evidence_path,
        near_sdk::serde_json::to_vec_pretty(&evidence)?,
    )?;
    let media_fixture_path =
        root().join("deployments/variable-city-contract-media-fixture-2026-11-12.json");
    std::fs::write(
        &media_fixture_path,
        near_sdk::serde_json::to_vec_pretty(&json!({
            "scope": "local sandbox get_plot views after a real owner proposal and moderator approval",
            "contractId": id,
            "plotId": unowned_wide.id(),
            "artFixturePath": "tests/fixtures/variable-city-media/fixture.json",
            "appearanceReference": appearance_reference,
            "logoHash": logo_hash,
            "pendingPlot": pending_facade_view,
            "approvedPlot": approved_facade_view,
            "logoApprovedPlot": approved_logo_view,
        }))?,
    )?;
    println!(
        "Sandbox city conversion passed: 100 plots, 180 curb spaces, {} owned moves, {} Tgas burned. Evidence: {}",
        owned_count,
        migration.total_gas_burnt.as_gas() as f64 / 1e12,
        evidence_path.display(),
    );
    Ok(())
}
