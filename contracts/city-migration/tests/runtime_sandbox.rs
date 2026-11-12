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
use near_workspaces::types::{Gas, NearToken};
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
    Ok(())
}
