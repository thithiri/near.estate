#![cfg(feature = "runtime")]

use anyhow::{ensure, Context, Result};
use near_estate_city_migration::CityRootV2;
use near_estate_contract::{
    BuildingType, GameConfig, GameConfigV2, PlotSeedV2, PlotV2, RoadId, Side,
};
use near_sdk::{
    borsh::{self, BorshSerialize},
    json_types::U128,
    serde_json::{json, Value},
    store::LookupMap,
};
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use std::path::PathBuf;

fn wasm_path() -> PathBuf {
    std::env::var_os("ESTATE_V2_WASM")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("target/wasm32-unknown-unknown/release/near_estate_city_migration.wasm")
        })
}

fn key<K: BorshSerialize>(prefix: u8, item: &K) -> Result<Vec<u8>> {
    let mut bytes = vec![prefix];
    bytes.extend(borsh::to_vec(item)?);
    Ok(bytes)
}

fn read_u128(value: &Value, field: &str) -> Result<u128> {
    Ok(value[field]
        .as_str()
        .with_context(|| format!("{field} missing"))?
        .parse()?)
}

#[tokio::test]
async fn deployed_runtime_parks_and_tickets_a_three_unit_curb() -> Result<()> {
    let wasm = std::fs::read(wasm_path()).context("build the version-2 runtime WASM first")?;
    ensure!(wasm.starts_with(b"\0asm"), "version-2 WASM is invalid");
    let sandbox = near_workspaces::sandbox().await?;
    let city = sandbox.dev_deploy(&wasm).await?;
    let owner = sandbox.dev_create_account().await?;
    let driver = sandbox.dev_create_account().await?;
    let moderator = sandbox.dev_create_account().await?;
    let inspector = sandbox.dev_create_account().await?;
    let seed = PlotSeedV2 {
        road_id: RoadId::Main,
        side: Side::North,
        index: 1,
        frontage_units: 3,
        building_type: BuildingType::Retail,
        variant: 1,
    };
    let mut plot = PlotV2::unowned(&seed);
    plot.owner = Some(owner.id().clone());
    plot.rule = near_estate_contract::ParkingRule::NoParking;
    plot.reserved_storage_bytes = 4_096;
    let plot_id = plot.id.clone();
    let root = CityRootV2 {
        admin: city.id().clone(),
        moderator: moderator.id().clone(),
        inspector: inspector.id().clone(),
        config: GameConfigV2::from_legacy(GameConfig::default()),
        paused: false,
        accounts: LookupMap::new(b"a"),
        cars: LookupMap::new(b"c"),
        next_car_id: 1,
        plots: LookupMap::new(b"P"),
        plot_ids: LookupMap::new(b"I"),
        plot_count: 1,
        npc_sites: LookupMap::new(b"n"),
        npc_site_ids: LookupMap::new(b"j"),
        npc_site_count: 0,
        sessions: LookupMap::new(b"s"),
        space_sessions: LookupMap::new(b"o"),
        next_session_id: 1,
        treasury_coins: U128(0),
        inspector_window_until: 0,
        inspector_attempts_in_window: 0,
        city_version: 2,
        legacy_plots: LookupMap::new(b"p"),
        legacy_plot_ids: LookupMap::new(b"i"),
        deed_moves: Vec::new(),
        source_plot_hash: String::new(),
        target_seed_hash: String::new(),
        source_root_hash: String::new(),
        initial_target_plot_hash: String::new(),
    };
    let root_bytes = borsh::to_vec(&root)?;
    let plot_key = key(b'P', &plot_id)?;
    let plot_bytes = borsh::to_vec(&plot)?;
    let plot_index_key = key(b'I', &0_u16)?;
    let plot_index_bytes = borsh::to_vec(&plot_id)?;
    sandbox
        .patch(city.id())
        .states([
            (b"STATE".as_slice(), root_bytes.as_slice()),
            (plot_key.as_slice(), plot_bytes.as_slice()),
            (plot_index_key.as_slice(), plot_index_bytes.as_slice()),
        ])
        .transact()
        .await?;

    let city_version: u8 = city.view("city_version").await?.json()?;
    ensure!(city_version == 2, "patched runtime root could not be read");
    let quote: String = city.view("registration_quote").await?.json()?;
    let quote: u128 = quote.parse()?;
    for player in [&owner, &driver] {
        let registration = player
            .call(city.id(), "register_player")
            .args_json(json!({"body": "Hatchback", "color": "Red"}))
            .deposit(NearToken::from_yoctonear(quote))
            .transact()
            .await?;
        ensure!(
            registration.is_success(),
            "registration failed: {registration:?}"
        );
    }
    let driver_cars: Vec<Value> = city
        .view("get_cars")
        .args_json(json!({"account_id": driver.id()}))
        .await?
        .json()?;
    let car_id = driver_cars[0]["id"]
        .as_u64()
        .context("starter car missing")?;

    let parked = driver
        .call(city.id(), "park")
        .args_json(json!({"car_id": car_id, "plot_id": plot_id, "slot": 2}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    ensure!(
        parked.is_success(),
        "third-space parking failed: {parked:?}"
    );
    let session: Value = parked.json()?;
    ensure!(session["legal"] == false, "NoParking became legal");
    let session_id = session["id"].as_u64().context("session ID missing")?;
    let occupied: Value = city
        .view("get_space_session")
        .args_json(json!({"plot_id": plot_id, "slot": 2}))
        .await?
        .json()?;
    ensure!(
        occupied["id"] == session_id,
        "third space did not store session"
    );

    sandbox.fast_forward(10).await?;
    let unauthorized = driver
        .call(city.id(), "ticket")
        .args_json(json!({"plot_id": plot_id, "slot": 2, "expected_session_id": session_id}))
        .transact()
        .await?;
    ensure!(
        !unauthorized.is_success(),
        "driver ticketed the owner's plot"
    );
    let ticket = owner
        .call(city.id(), "ticket")
        .args_json(json!({"plot_id": plot_id, "slot": 2, "expected_session_id": session_id}))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    ensure!(ticket.is_success(), "owner ticket failed: {ticket:?}");
    let payout: Value = ticket.json()?;
    let gross = read_u128(&payout, "gross")?;
    let recipient = read_u128(&payout, "recipient_payout")?;
    ensure!(gross > 0, "ticket earned no coins");
    ensure!(recipient == gross * 7_000 / 10_000, "owner split differs");
    ensure!(
        read_u128(&payout, "forfeited")? == gross - recipient,
        "ticket burn differs"
    );
    let owner_after: Value = city
        .view("get_account")
        .args_json(json!({"account_id": owner.id()}))
        .await?
        .json()?;
    let balance_after = read_u128(&owner_after, "balance")?;
    ensure!(
        balance_after == 100_000_000 + recipient,
        "owner balance differs"
    );
    let freed: Value = city
        .view("get_space_session")
        .args_json(json!({"plot_id": plot_id, "slot": 2}))
        .await?
        .json()?;
    ensure!(freed.is_null(), "ticket did not free the third space");
    let duplicate = owner
        .call(city.id(), "ticket")
        .args_json(json!({"plot_id": plot_id, "slot": 2, "expected_session_id": session_id}))
        .transact()
        .await?;
    ensure!(!duplicate.is_success(), "same session paid twice");
    let owner_after_duplicate: Value = city
        .view("get_account")
        .args_json(json!({"account_id": owner.id()}))
        .await?
        .json()?;
    ensure!(
        read_u128(&owner_after_duplicate, "balance")? == balance_after,
        "duplicate ticket changed owner balance"
    );

    let agent_secret = SecretKey::from_seed(KeyType::ED25519, "plot-owner-agent-v1");
    let agent_public_key = agent_secret.public_key();
    let added = owner
        .batch(owner.id())
        .add_key(
            agent_public_key.clone(),
            AccessKey::function_call_access(
                city.id(),
                &[
                    "agent_set_rule",
                    "agent_ticket",
                    "agent_choose_design",
                    "agent_upgrade_building",
                ],
                Some(NearToken::from_yoctonear(50 * 10u128.pow(21))),
            ),
        )
        .transact()
        .await?;
    ensure!(added.is_success(), "agent key creation failed: {added:?}");
    let agent =
        near_workspaces::Account::from_secret_key(owner.id().clone(), agent_secret, &sandbox);
    let agent_quote: String = city.view("plot_agent_storage_quote").await?.json()?;
    let now: u64 = city.view("chain_time_seconds").await?.json()?;
    let authorized = owner
        .call(city.id(), "authorize_plot_agent")
        .args_json(json!({
            "public_key": agent_public_key.to_string(),
            "plot_ids": [plot_id],
            "expires_at": now + 3_600,
            "daily_coin_limit": "0",
            "daily_action_limit": 2,
            "allow_design_changes": false
        }))
        .deposit(NearToken::from_yoctonear(agent_quote.parse()?))
        .transact()
        .await?;
    ensure!(
        authorized.is_success(),
        "agent grant failed: {authorized:?}"
    );
    let changed = agent
        .call(city.id(), "agent_set_rule")
        .args_json(json!({"plot_id": plot_id, "rule": {"kind": "Free"}}))
        .transact()
        .await?;
    ensure!(changed.is_success(), "agent rule failed: {changed:?}");
    let bypass = agent
        .call(city.id(), "set_rule")
        .args_json(json!({"plot_id": plot_id, "rule": {"kind": "Free"}}))
        .transact()
        .await;
    ensure!(
        match bypass {
            Ok(outcome) => !outcome.is_success(),
            Err(_) => true,
        },
        "agent bypassed restricted method list"
    );
    let design = agent
        .call(city.id(), "agent_choose_design")
        .args_json(json!({"plot_id": plot_id, "choice": 1}))
        .transact()
        .await?;
    ensure!(
        !design.is_success(),
        "agent changed design without permission"
    );
    let revoked = owner
        .call(city.id(), "revoke_plot_agent")
        .transact()
        .await?;
    ensure!(
        revoked.is_success(),
        "agent grant revoke failed: {revoked:?}"
    );
    let after_revoke = agent
        .call(city.id(), "agent_set_rule")
        .args_json(json!({"plot_id": plot_id, "rule": {"kind": "Free"}}))
        .transact()
        .await?;
    ensure!(!after_revoke.is_success(), "revoked agent still acted");

    let first_facade = owner
        .call(city.id(), "propose_appearance")
        .args_json(json!({
            "plot_id": plot_id,
            "expected_revision": 1,
            "manifest_hash": "a".repeat(64)
        }))
        .transact()
        .await?;
    ensure!(
        first_facade.is_success(),
        "facade proposal failed: {first_facade:?}"
    );
    let first_facade: Value = first_facade.json()?;
    let approved_facade = moderator
        .call(city.id(), "approve_appearance")
        .args_json(json!({"plot_id": plot_id, "expected": first_facade}))
        .transact()
        .await?;
    ensure!(
        approved_facade.is_success(),
        "facade approval failed: {approved_facade:?}"
    );
    let replacement_facade = owner
        .call(city.id(), "propose_appearance")
        .args_json(json!({
            "plot_id": plot_id,
            "expected_revision": first_facade["revision"],
            "manifest_hash": "b".repeat(64)
        }))
        .transact()
        .await?;
    ensure!(
        replacement_facade.is_success(),
        "replacement facade failed: {replacement_facade:?}"
    );
    let revoked_facade = moderator
        .call(city.id(), "revoke_appearance")
        .args_json(json!({
            "plot_id": plot_id,
            "expected_revision": first_facade["revision"],
            "expected_manifest_hash": "a".repeat(64),
            "reason": "Unsafe facade"
        }))
        .transact()
        .await?;
    ensure!(
        revoked_facade.is_success(),
        "facade revocation raced: {revoked_facade:?}"
    );
    let plot_after_facade: Value = city
        .view("get_plot")
        .args_json(json!({"plot_id": plot_id}))
        .await?
        .json()?;
    ensure!(
        plot_after_facade["plot"]["building"]["approved_manifest_hash"].is_null()
            && plot_after_facade["plot"]["building"]["pending_appearance"].is_null(),
        "facade or pending replacement survived revocation"
    );

    let layout_revision = plot_after_facade["plot"]["building"]["layout_revision"]
        .as_u64()
        .context("layout revision missing")?;
    let first_logo = owner
        .call(city.id(), "propose_media")
        .args_json(json!({
            "plot_id": plot_id,
            "kind": "Logo",
            "expected_media_revision": 0,
            "expected_layout_revision": layout_revision,
            "content": {"asset_hash": "c".repeat(64), "link": null}
        }))
        .transact()
        .await?;
    ensure!(
        first_logo.is_success(),
        "logo proposal failed: {first_logo:?}"
    );
    let first_logo: Value = first_logo.json()?;
    let approved_logo = moderator
        .call(city.id(), "approve_media")
        .args_json(json!({"plot_id": plot_id, "kind": "Logo", "expected": first_logo}))
        .transact()
        .await?;
    ensure!(
        approved_logo.is_success(),
        "logo approval failed: {approved_logo:?}"
    );
    let replacement_logo = owner
        .call(city.id(), "propose_media")
        .args_json(json!({
            "plot_id": plot_id,
            "kind": "Logo",
            "expected_media_revision": first_logo["revision"],
            "expected_layout_revision": layout_revision,
            "content": {"asset_hash": "d".repeat(64), "link": null}
        }))
        .transact()
        .await?;
    ensure!(
        replacement_logo.is_success(),
        "replacement logo failed: {replacement_logo:?}"
    );
    let revoked_logo = moderator
        .call(city.id(), "revoke_media")
        .args_json(json!({
            "plot_id": plot_id,
            "kind": "Logo",
            "expected_media_revision": first_logo["revision"],
            "expected_content": {"asset_hash": "c".repeat(64), "link": null},
            "reason": "Unsafe logo"
        }))
        .transact()
        .await?;
    ensure!(
        revoked_logo.is_success(),
        "logo revocation raced: {revoked_logo:?}"
    );
    let plot_after_logo: Value = city
        .view("get_plot")
        .args_json(json!({"plot_id": plot_id}))
        .await?
        .json()?;
    ensure!(
        plot_after_logo["plot"]["logo"]["active"].is_null()
            && plot_after_logo["plot"]["logo"]["pending"].is_null(),
        "logo or pending replacement survived revocation"
    );
    Ok(())
}
