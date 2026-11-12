#![cfg_attr(feature = "reverse", allow(dead_code, unused_imports))]

#[cfg(all(target_arch = "wasm32", not(near)))]
compile_error!("NEAR city migration WASM must be built with --cfg near");

#[cfg(all(feature = "runtime", feature = "reverse"))]
compile_error!("runtime and reverse features cannot be combined");
#[cfg(all(feature = "repair-npc", feature = "reverse"))]
compile_error!("repair-npc and reverse features cannot be combined");

#[cfg(feature = "repair-npc")]
mod repair_npc;
#[cfg(feature = "runtime")]
mod runtime;
#[cfg(all(test, feature = "runtime"))]
mod runtime_tests;

use near_estate_contract::{
    AccountState, Car, GameConfig, GameConfigV2, NPCSite, ParkingSession, Plot, PlotSeedV2, PlotV2,
    RoadId, ServiceRole, Side,
};
use near_sdk::{
    borsh::{self, BorshDeserialize, BorshSerialize},
    env,
    json_types::U128,
    near, require,
    store::LookupMap,
    AccountId, PanicOnDefault,
};
use std::collections::{HashMap, HashSet};

// Borsh hash of contracts/estate/seed-v2.json's ordered PlotSeedV2 values.
const CANONICAL_TARGET_SEED_HASH: &str =
    "8903238d2d25c8431ef581dcef8ad6995f15175085441519732a92079c5ee813";

// Match the deployed root field order exactly. Map handles retain their V1
// prefixes and are moved without rewriting player, car or civic-site values.
#[derive(BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct LegacyRoot {
    pub admin: AccountId,
    pub moderator: AccountId,
    pub inspector: AccountId,
    pub config: GameConfig,
    pub paused: bool,
    pub accounts: LookupMap<AccountId, AccountState>,
    pub cars: LookupMap<u64, Car>,
    pub next_car_id: u64,
    pub plots: LookupMap<String, Plot>,
    pub plot_ids: LookupMap<u16, String>,
    pub plot_count: u16,
    pub npc_sites: LookupMap<String, NPCSite>,
    pub npc_site_ids: LookupMap<u8, String>,
    pub npc_site_count: u8,
    pub sessions: LookupMap<u64, ParkingSession>,
    pub space_sessions: LookupMap<String, u64>,
    pub next_session_id: u64,
    pub treasury_coins: U128,
    pub inspector_window_until: u64,
    pub inspector_attempts_in_window: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct DeedMove {
    pub from: String,
    pub to: String,
}

#[derive(BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
pub struct CityRootV2 {
    pub admin: AccountId,
    pub moderator: AccountId,
    pub inspector: AccountId,
    pub config: GameConfigV2,
    pub paused: bool,
    pub accounts: LookupMap<AccountId, AccountState>,
    pub cars: LookupMap<u64, Car>,
    pub next_car_id: u64,
    pub plots: LookupMap<String, PlotV2>,
    pub plot_ids: LookupMap<u16, String>,
    pub plot_count: u16,
    pub npc_sites: LookupMap<String, NPCSite>,
    pub npc_site_ids: LookupMap<u8, String>,
    pub npc_site_count: u8,
    pub sessions: LookupMap<u64, ParkingSession>,
    pub space_sessions: LookupMap<String, u64>,
    pub next_session_id: u64,
    pub treasury_coins: U128,
    pub inspector_window_until: u64,
    pub inspector_attempts_in_window: u8,
    pub city_version: u8,
    pub legacy_plots: LookupMap<String, Plot>,
    pub legacy_plot_ids: LookupMap<u16, String>,
    pub deed_moves: Vec<DeedMove>,
    pub source_plot_hash: String,
    pub target_seed_hash: String,
    pub source_root_hash: String,
    pub initial_target_plot_hash: String,
}

#[cfg(not(feature = "reverse"))]
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    inner: CityRootV2,
}

#[cfg(feature = "reverse")]
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    inner: LegacyRoot,
}

fn hash_borsh<T: BorshSerialize>(value: &T) -> String {
    let bytes = borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("hash encoding failed"));
    env::sha256(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn validate_seeds(seeds: &[PlotSeedV2]) {
    require!(seeds.len() == 100, "version-2 city requires 100 plots");
    let roads = [
        RoadId::Main,
        RoadId::Market,
        RoadId::River,
        RoadId::Central,
        RoadId::Harbor,
    ];
    let sides = [Side::North, Side::South];
    for (road_index, road) in roads.iter().enumerate() {
        for (side_index, side) in sides.iter().enumerate() {
            let mut width_counts = [0_u8; 3];
            for index in 0..10 {
                let seed = &seeds[road_index * 20 + side_index * 10 + index];
                seed.validate();
                require!(seed.road_id == *road, "seed road order differs");
                require!(seed.side == *side, "seed side order differs");
                require!(usize::from(seed.index) == index, "seed index differs");
                width_counts[usize::from(seed.frontage_units - 1)] += 1;
            }
            require!(
                width_counts == [3, 6, 1],
                "street side must use 3/6/1 plot mix"
            );
        }
    }
}

#[cfg(not(feature = "reverse"))]
#[near]
impl Contract {
    #[init(ignore_state)]
    pub fn migrate_city(
        seeds: Vec<PlotSeedV2>,
        moves: Vec<DeedMove>,
        expected_config_version: u32,
        expected_source_plot_hash: String,
        expected_target_seed_hash: String,
    ) -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the contract account can migrate"
        );
        let old: LegacyRoot =
            env::state_read().unwrap_or_else(|| env::panic_str("legacy city state is missing"));
        require!(
            old.admin == env::current_account_id(),
            "legacy admin differs"
        );
        require!(old.paused, "pause the legacy city before migration");
        require!(old.plot_count == 80, "legacy plot count differs");
        require!(old.npc_site_count == 7, "legacy civic-site count differs");
        require!(
            old.config.version == expected_config_version,
            "legacy config version differs"
        );
        let source_root_hash = hash_borsh(&old);
        validate_seeds(&seeds);
        let actual_target_seed_hash = hash_borsh(&seeds);
        require!(
            actual_target_seed_hash == CANONICAL_TARGET_SEED_HASH,
            "target seed is not the reviewed city"
        );
        require!(
            actual_target_seed_hash == expected_target_seed_hash,
            "target seed hash differs"
        );

        let mut old_plots = Vec::with_capacity(80);
        for index in 0..old.plot_count {
            let id = old
                .plot_ids
                .get(&index)
                .unwrap_or_else(|| env::panic_str("legacy plot index missing"));
            let plot = old
                .plots
                .get(id)
                .unwrap_or_else(|| env::panic_str("legacy plot missing"));
            require!(plot.id == *id, "legacy plot ID differs");
            for slot in 0..2 {
                require!(
                    old.space_sessions.get(&format!("c:{id}:{slot}")).is_none(),
                    "clear every curb session before migration"
                );
            }
            old_plots.push(plot.clone());
        }
        require!(
            hash_borsh(&old_plots) == expected_source_plot_hash,
            "source plot hash differs"
        );
        for index in 0..old.npc_site_count {
            let id = old
                .npc_site_ids
                .get(&index)
                .unwrap_or_else(|| env::panic_str("legacy civic-site index missing"));
            let site = old
                .npc_sites
                .get(id)
                .unwrap_or_else(|| env::panic_str("legacy civic site missing"));
            if site.role == ServiceRole::ParkingTower {
                for slot in 0..site.capacity {
                    require!(
                        old.space_sessions.get(&format!("t:{id}:{slot}")).is_none(),
                        "clear every tower session before migration"
                    );
                }
            }
        }

        let mut owned = HashMap::new();
        for plot in old_plots {
            if plot.owner.is_some() {
                owned.insert(plot.id.clone(), plot);
            }
        }
        require!(
            moves.len() == owned.len(),
            "every owned deed needs one move"
        );
        let mut moved_from = HashSet::new();
        let mut moved_to = HashSet::new();
        let seed_by_id: HashMap<String, &PlotSeedV2> =
            seeds.iter().map(|seed| (seed.id(), seed)).collect();
        for deed in &moves {
            require!(
                moved_from.insert(deed.from.clone()),
                "duplicate source deed"
            );
            require!(
                moved_to.insert(deed.to.clone()),
                "duplicate destination deed"
            );
            let plot = owned
                .get(&deed.from)
                .unwrap_or_else(|| env::panic_str("source deed is not owned"));
            let target = seed_by_id
                .get(&deed.to)
                .unwrap_or_else(|| env::panic_str("destination plot missing"));
            require!(
                plot.road_id == target.road_id && plot.side == target.side,
                "deed move changes street side"
            );
            require!(target.frontage_units == 2, "deed move shrinks frontage");
            let owner = plot
                .owner
                .as_ref()
                .unwrap_or_else(|| env::panic_str("deed owner missing"));
            require!(
                old.accounts.get(owner).is_some(),
                "deed owner account missing"
            );
        }

        let mut plots = LookupMap::new(b"P");
        let mut plot_ids = LookupMap::new(b"I");
        let mut target_plots = Vec::with_capacity(100);
        let target_to_source: HashMap<&str, &str> = moves
            .iter()
            .map(|deed| (deed.to.as_str(), deed.from.as_str()))
            .collect();
        for (index, seed) in seeds.iter().enumerate() {
            let id = seed.id();
            let converted = match target_to_source.get(id.as_str()) {
                Some(source) => PlotV2::relocate_owned(
                    owned
                        .remove(*source)
                        .unwrap_or_else(|| env::panic_str("source deed was already moved")),
                    seed,
                ),
                None => PlotV2::unowned(seed),
            };
            require!(
                plots.insert(id.clone(), converted.clone()).is_none(),
                "duplicate plot"
            );
            target_plots.push(converted);
            require!(
                plot_ids.insert(index as u16, id).is_none(),
                "duplicate plot index"
            );
        }
        require!(owned.is_empty(), "an owned deed was not moved");
        let config = GameConfigV2::from_legacy(old.config);
        Self {
            inner: CityRootV2 {
                admin: old.admin,
                moderator: old.moderator,
                inspector: old.inspector,
                config,
                paused: true,
                accounts: old.accounts,
                cars: old.cars,
                next_car_id: old.next_car_id,
                plots,
                plot_ids,
                plot_count: 100,
                npc_sites: old.npc_sites,
                npc_site_ids: old.npc_site_ids,
                npc_site_count: old.npc_site_count,
                sessions: old.sessions,
                space_sessions: old.space_sessions,
                next_session_id: old.next_session_id,
                treasury_coins: old.treasury_coins,
                inspector_window_until: old.inspector_window_until,
                inspector_attempts_in_window: old.inspector_attempts_in_window,
                city_version: 2,
                legacy_plots: old.plots,
                legacy_plot_ids: old.plot_ids,
                deed_moves: moves,
                source_plot_hash: expected_source_plot_hash,
                target_seed_hash: expected_target_seed_hash,
                source_root_hash,
                initial_target_plot_hash: hash_borsh(&target_plots),
            },
        }
    }

    pub fn city_version(&self) -> u8 {
        self.inner.city_version
    }

    pub fn migration_summary(&self) -> (u8, u16, u8, u32, String, String) {
        (
            self.inner.city_version,
            self.inner.plot_count,
            self.inner.npc_site_count,
            self.inner.config.version,
            self.inner.source_plot_hash.clone(),
            self.inner.target_seed_hash.clone(),
        )
    }

    pub fn get_plot_v2(&self, plot_id: String) -> Option<PlotV2> {
        self.inner.plots.get(&plot_id).cloned()
    }

    pub fn get_deed_moves(&self) -> Vec<DeedMove> {
        self.inner.deed_moves.clone()
    }
}

#[cfg(feature = "reverse")]
#[near]
impl Contract {
    #[init(ignore_state)]
    pub fn reverse_city() -> Self {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "only the contract account can reverse"
        );
        let mut city: CityRootV2 =
            env::state_read().unwrap_or_else(|| env::panic_str("version-2 city state is missing"));
        require!(
            city.admin == env::current_account_id(),
            "city admin differs"
        );
        require!(city.paused, "city must remain paused for reverse");
        require!(city.city_version == 2, "city version differs");
        require!(city.plot_count == 100, "version-2 plot count differs");
        let mut legacy_plots = Vec::with_capacity(80);
        for index in 0..80_u16 {
            let id = city
                .legacy_plot_ids
                .get(&index)
                .unwrap_or_else(|| env::panic_str("legacy plot index missing"));
            let plot = city
                .legacy_plots
                .get(id)
                .unwrap_or_else(|| env::panic_str("legacy plot missing"));
            legacy_plots.push(plot.clone());
        }
        require!(
            hash_borsh(&legacy_plots) == city.source_plot_hash,
            "legacy plot hash changed"
        );
        let mut target_plots = Vec::with_capacity(100);
        for index in 0..city.plot_count {
            let id = city
                .plot_ids
                .get(&index)
                .unwrap_or_else(|| env::panic_str("version-2 plot index missing"));
            target_plots.push(
                city.plots
                    .get(id)
                    .unwrap_or_else(|| env::panic_str("version-2 plot missing"))
                    .clone(),
            );
        }
        require!(
            hash_borsh(&target_plots) == city.initial_target_plot_hash,
            "version-2 plot data changed"
        );
        for index in 0..city.plot_count {
            let id = city
                .plot_ids
                .get(&index)
                .unwrap_or_else(|| env::panic_str("version-2 plot index missing"))
                .clone();
            require!(city.plots.remove(&id).is_some(), "version-2 plot missing");
            require!(
                city.plot_ids.remove(&index).is_some(),
                "version-2 plot index missing"
            );
        }
        city.plots.flush();
        city.plot_ids.flush();
        let expected_root_hash = city.source_root_hash.clone();
        let legacy = LegacyRoot {
            admin: city.admin,
            moderator: city.moderator,
            inspector: city.inspector,
            config: city.config.into_legacy(),
            paused: true,
            accounts: city.accounts,
            cars: city.cars,
            next_car_id: city.next_car_id,
            plots: city.legacy_plots,
            plot_ids: city.legacy_plot_ids,
            plot_count: 80,
            npc_sites: city.npc_sites,
            npc_site_ids: city.npc_site_ids,
            npc_site_count: city.npc_site_count,
            sessions: city.sessions,
            space_sessions: city.space_sessions,
            next_session_id: city.next_session_id,
            treasury_coins: city.treasury_coins,
            inspector_window_until: city.inspector_window_until,
            inspector_attempts_in_window: city.inspector_attempts_in_window,
        };
        require!(
            hash_borsh(&legacy) == expected_root_hash,
            "legacy root data changed"
        );
        Self { inner: legacy }
    }
}

#[cfg(all(test, not(feature = "reverse")))]
mod tests {
    use super::*;
    use near_estate_contract::BuildingType;
    use near_estate_migration_probe::RootV1;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};

    fn empty_legacy_root(contract_id: AccountId) -> LegacyRoot {
        LegacyRoot {
            admin: contract_id,
            moderator: "moderator.testnet".parse().expect("moderator ID"),
            inspector: "inspector.testnet".parse().expect("inspector ID"),
            config: GameConfig::default(),
            paused: false,
            accounts: LookupMap::new(b"a"),
            cars: LookupMap::new(b"c"),
            next_car_id: 1,
            plots: LookupMap::new(b"p"),
            plot_ids: LookupMap::new(b"i"),
            plot_count: 0,
            npc_sites: LookupMap::new(b"n"),
            npc_site_ids: LookupMap::new(b"j"),
            npc_site_count: 0,
            sessions: LookupMap::new(b"s"),
            space_sessions: LookupMap::new(b"o"),
            next_session_id: 1,
            treasury_coins: U128(0),
            inspector_window_until: 0,
            inspector_attempts_in_window: 0,
        }
    }

    #[test]
    fn legacy_root_matches_the_deployed_contract_layout() {
        let contract_id: AccountId = "city.testnet".parse().expect("contract ID");
        testing_env!(VMContextBuilder::new()
            .current_account_id(contract_id.clone())
            .predecessor_account_id(contract_id.clone())
            .build());
        let fixture = empty_legacy_root(contract_id.clone());
        let bytes = borsh::to_vec(&fixture).expect("legacy bytes");
        let frozen: RootV1 = borsh::from_slice(&bytes).expect("frozen V1 layout");
        assert_eq!(borsh::to_vec(&frozen).expect("frozen round trip"), bytes);
        let parsed: LegacyRoot = borsh::from_slice(&bytes).expect("legacy layout");
        assert_eq!(parsed.admin, contract_id);
        assert_eq!(parsed.config.version, 1);
        assert_eq!(borsh::to_vec(&parsed).expect("round trip"), bytes);
    }

    fn version_two_seeds() -> Vec<PlotSeedV2> {
        let city: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(include_str!("../../estate/seed-v2.json"))
                .expect("version-2 seed JSON");
        city["plots"]
            .as_array()
            .expect("plots array")
            .iter()
            .map(|plot| PlotSeedV2 {
                road_id: near_sdk::serde_json::from_value(plot["roadId"].clone()).expect("road ID"),
                side: near_sdk::serde_json::from_value(plot["side"].clone()).expect("side"),
                index: plot["index"].as_u64().expect("index") as u8,
                frontage_units: plot["frontageUnits"].as_u64().expect("units") as u8,
                building_type: near_sdk::serde_json::from_value(plot["initialType"].clone())
                    .expect("building type"),
                variant: plot["initialVariant"].as_u64().expect("variant") as u8,
            })
            .collect()
    }

    #[test]
    fn converts_real_seed_shape_and_keeps_owned_deed_data() {
        let contract_id: AccountId = "city.testnet".parse().expect("contract ID");
        let owner: AccountId = "owner.testnet".parse().expect("owner ID");
        testing_env!(VMContextBuilder::new()
            .current_account_id(contract_id.clone())
            .predecessor_account_id(contract_id.clone())
            .build());
        let mut old = empty_legacy_root(contract_id.clone());
        let roads = [
            RoadId::Main,
            RoadId::Market,
            RoadId::River,
            RoadId::Central,
            RoadId::Harbor,
        ];
        let sides = [Side::North, Side::South];
        let mut source = Vec::new();
        for road in roads {
            for side in sides {
                for index in 0..8 {
                    let seed = PlotSeedV2 {
                        road_id: road,
                        side,
                        index,
                        frontage_units: 2,
                        building_type: BuildingType::Retail,
                        variant: 1,
                    };
                    let template = PlotV2::unowned(&seed);
                    let mut plot = Plot {
                        id: template.id,
                        road_id: road,
                        side,
                        index,
                        corner: index == 0 || index == 7,
                        owner: None,
                        rule: template.rule,
                        pending_rule: None,
                        building: template.building,
                        logo: template.logo,
                        billboard: template.billboard,
                        ticket_cooldown_until: 0,
                        reserved_storage_bytes: 0,
                        used_storage_bytes: 0,
                    };
                    if plot.id == "plot-main-n-2" || plot.id == "plot-market-n-1" {
                        plot.owner = Some(owner.clone());
                        plot.building.name = format!("Owned {}", plot.id);
                        plot.building.level = 2;
                        plot.reserved_storage_bytes = 4096;
                        plot.used_storage_bytes = 301;
                    }
                    old.plot_ids.insert(old.plot_count, plot.id.clone());
                    old.plots.insert(plot.id.clone(), plot.clone());
                    old.plot_count += 1;
                    source.push(plot);
                }
            }
        }
        old.accounts.insert(
            owner.clone(),
            AccountState {
                balance: 123_000_000u128.into(),
                car_ids: vec![9],
                starter_car_id: 9,
                active_session_id: None,
                last_emergency_repair_at: None,
                burger_decal: true,
                reserved_storage_bytes: 4096,
                used_storage_bytes: 120,
            },
        );
        old.cars.insert(
            9,
            Car {
                id: 9,
                owner: owner.clone(),
                body: near_estate_contract::CarBody::Pickup,
                color: near_estate_contract::CarColor::Green,
                tier: 2,
                durability: 87,
                parked_session_id: None,
            },
        );
        old.next_car_id = 10;
        for index in 0..7_u8 {
            let id = format!("npc-tower-{index}");
            old.npc_site_ids.insert(index, id.clone());
            old.npc_sites.insert(
                id.clone(),
                NPCSite {
                    id,
                    road_id: RoadId::Main,
                    side: Side::North,
                    frontage_index: 8 + index % 4,
                    role: ServiceRole::ParkingTower,
                    name: "Tower".to_string(),
                    capacity: 32,
                },
            );
            old.npc_site_count += 1;
        }
        old.paused = true;
        let source_hash = hash_borsh(&source);
        let seeds = version_two_seeds();
        let target_hash = hash_borsh(&seeds);
        assert_eq!(target_hash, CANONICAL_TARGET_SEED_HASH);
        old.plots.flush();
        old.plot_ids.flush();
        old.accounts.flush();
        old.cars.flush();
        old.npc_sites.flush();
        old.npc_site_ids.flush();
        env::state_write(&old);
        drop(old);

        let converted = Contract::migrate_city(
            seeds,
            vec![
                DeedMove {
                    from: "plot-main-n-2".to_string(),
                    to: "plot-main-n-3".to_string(),
                },
                DeedMove {
                    from: "plot-market-n-1".to_string(),
                    to: "plot-market-n-2".to_string(),
                },
            ],
            1,
            source_hash.clone(),
            target_hash.clone(),
        );
        assert_eq!(
            converted.migration_summary(),
            (2, 100, 7, 2, source_hash, target_hash)
        );
        assert_eq!(
            converted.inner.config.plot_unit_price_yocto.0,
            500_000_000_000_000_000_000_000
        );
        assert_eq!(
            converted
                .inner
                .accounts
                .get(&owner)
                .expect("account")
                .balance
                .0,
            123_000_000
        );
        assert_eq!(converted.inner.cars.get(&9).expect("car").durability, 87);
        let moved = converted
            .get_plot_v2("plot-main-n-3".to_string())
            .expect("moved plot");
        assert_eq!(moved.owner, Some(owner));
        assert_eq!(moved.building.level, 2);
        assert_eq!(moved.reserved_storage_bytes, 4096);
        assert_eq!(moved.used_storage_bytes, 301);
        assert!(converted
            .inner
            .legacy_plots
            .get(&"plot-main-n-2".to_string())
            .is_some());
    }
}
