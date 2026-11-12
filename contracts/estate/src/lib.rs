#![cfg_attr(feature = "migration-types", allow(dead_code, unused_imports))]

#[cfg(all(target_arch = "wasm32", not(near)))]
compile_error!("NEAR contract WASM must be built with --cfg near");

use near_sdk::{
    env, json_types::U128, near, require, store::LookupMap, AccountId, NearToken, PanicOnDefault,
    Promise,
};

mod city_v2;
mod parking;
mod world;
pub use city_v2::{plot_price_yocto, GameConfigV2, PlotSeedV2, PlotV2};
pub use parking::{
    calculate_settlement, Facility, ParkingSession, SessionTerms, Settlement, SettlementReason,
};
pub use world::{
    AppearanceDecision, AppearanceReference, AppearanceStatus, BuildingState, BuildingType,
    MediaApproval, MediaDecision, MediaDecisionStatus, MediaIdentity, MediaKind, MediaProposal,
    MediaSlot, NPCSite, NPCSiteSeed, ParkingRule, PendingRule, Plot, PlotPurchaseBreakdown,
    PlotSeed, PlotView, RoadId, ServiceRole, Side,
};

const TOWER_SPACES_PER_FLOOR: u8 = 8;
const MAX_MODERATION_REASON_BYTES: usize = 240;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CarBody {
    Hatchback,
    Sedan,
    SportsCoupe,
    SUV,
    Pickup,
    Microvan,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CarColor {
    Red,
    Blue,
    Yellow,
    Green,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Car {
    pub id: u64,
    pub owner: AccountId,
    pub body: CarBody,
    pub color: CarColor,
    pub tier: u8,
    pub durability: u8,
    pub parked_session_id: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct ParkedCarAppearance {
    pub id: u64,
    pub body: CarBody,
    pub color: CarColor,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AccountState {
    pub balance: U128,
    pub car_ids: Vec<u64>,
    pub starter_car_id: u64,
    pub active_session_id: Option<u64>,
    pub last_emergency_repair_at: Option<u64>,
    pub burger_decal: bool,
    pub reserved_storage_bytes: u32,
    pub used_storage_bytes: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct StreetPlotView {
    pub plot: PlotView,
    pub slots: [Option<ParkingSession>; 2],
    pub car_appearances: [Option<ParkedCarAppearance>; 2],
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct StreetSideView {
    pub road_id: RoadId,
    pub side: Side,
    pub plots: Vec<StreetPlotView>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct GameConfig {
    pub version: u32,
    pub coin_scale: u64,
    pub starter_coins: U128,
    pub base_rate_per_hour: U128,
    pub tier_multiplier_bps: [u16; 3],
    pub illegal_multiplier_bps: u16,
    pub tower_multiplier_bps: u16,
    pub earn_cap_seconds: u32,
    pub expiry_grace_seconds: u32,
    pub park_durability_cost: u8,
    pub max_durability: u8,
    pub max_cars: u8,
    pub account_storage_bytes: u32,
    pub plot_storage_bytes: u32,
    pub repair_cost_per_point: U128,
    pub buy_car_cost: U128,
    pub tier_upgrade_costs: [U128; 2],
    pub building_upgrade_costs: [U128; 3],
    pub change_building_type_cost: U128,
    pub meter_rate_max_per_hour: U128,
    pub rule_delay_seconds: u32,
    pub ticket_cooldown_seconds: u32,
    pub ticket_recipient_bps: u16,
    pub inspector_chance_bps: u16,
    pub inspector_min_age_seconds: u32,
    pub inspector_window_seconds: u32,
    pub inspector_max_attempts_per_window: u8,
    pub plot_base_price_yocto: U128,
    pub corner_price_bps: u16,
    pub tower_capacity: u8,
    pub burger_decal_cost: U128,
    pub logo_cooldown_seconds: u32,
    pub facade_cooldown_seconds: u32,
    pub emergency_repair_cooldown_seconds: u32,
}

impl Default for GameConfig {
    fn default() -> Self {
        const COIN: u128 = 1_000_000;
        Self {
            version: 1,
            coin_scale: 1_000_000,
            starter_coins: U128(100 * COIN),
            base_rate_per_hour: U128(60 * COIN),
            tier_multiplier_bps: [10_000, 15_000, 22_000],
            illegal_multiplier_bps: 15_000,
            tower_multiplier_bps: 5_000,
            earn_cap_seconds: 1_800,
            expiry_grace_seconds: 120,
            park_durability_cost: 2,
            max_durability: 100,
            max_cars: 3,
            account_storage_bytes: 4_096,
            plot_storage_bytes: 4_096,
            repair_cost_per_point: U128(COIN),
            buy_car_cost: U128(150 * COIN),
            tier_upgrade_costs: [U128(200 * COIN), U128(500 * COIN)],
            building_upgrade_costs: [U128(200 * COIN), U128(600 * COIN), U128(1_500 * COIN)],
            change_building_type_cost: U128(100 * COIN),
            meter_rate_max_per_hour: U128(30 * COIN),
            rule_delay_seconds: 300,
            ticket_cooldown_seconds: 300,
            ticket_recipient_bps: 7_000,
            inspector_chance_bps: 2_500,
            inspector_min_age_seconds: 300,
            inspector_window_seconds: 300,
            inspector_max_attempts_per_window: 8,
            plot_base_price_yocto: U128(1_000_000_000_000_000_000_000_000),
            corner_price_bps: 20_000,
            tower_capacity: 32,
            burger_decal_cost: U128(30 * COIN),
            logo_cooldown_seconds: 259_200,
            facade_cooldown_seconds: 86_400,
            emergency_repair_cooldown_seconds: 86_400,
        }
    }
}

impl GameConfig {
    pub fn validate(&self) {
        const COIN: u128 = 1_000_000;
        require!(
            self.version >= 1 && self.version <= 1_000_000,
            "config version out of bounds"
        );
        require!(self.coin_scale == 1_000_000, "coin scale is fixed in V1");
        require!(
            self.starter_coins.0 <= 10_000 * COIN,
            "starter coins out of bounds"
        );
        require!(
            self.base_rate_per_hour.0 <= 1_000_000 * COIN,
            "base rate out of bounds"
        );
        require!(
            self.max_cars >= 1 && self.max_cars <= 3,
            "max cars out of bounds"
        );
        require!(
            (1_024..=16_384).contains(&self.account_storage_bytes)
                && (512..=8_192).contains(&self.plot_storage_bytes),
            "storage reserve bytes out of bounds"
        );
        require!(
            self.max_durability >= 2 && self.max_durability <= 100,
            "max durability out of bounds"
        );
        require!(
            self.park_durability_cost >= 1 && self.park_durability_cost <= self.max_durability,
            "invalid parking durability cost"
        );
        require!(
            self.earn_cap_seconds >= 60 && self.earn_cap_seconds <= 86_400,
            "earn cap out of bounds"
        );
        require!(
            self.expiry_grace_seconds <= 3_600,
            "expiry grace out of bounds"
        );
        require!(
            self.tier_multiplier_bps
                .iter()
                .all(|value| (10_000..=30_000).contains(value)),
            "tier multiplier out of bounds"
        );
        require!(
            (10_000..=20_000).contains(&self.illegal_multiplier_bps),
            "illegal multiplier out of bounds"
        );
        require!(
            (1_000..=10_000).contains(&self.tower_multiplier_bps),
            "tower multiplier out of bounds"
        );
        require!(
            self.ticket_recipient_bps <= 10_000 && self.inspector_chance_bps <= 10_000,
            "basis points out of bounds"
        );
        require!(
            self.meter_rate_max_per_hour.0 <= 30_000_000,
            "meter rate out of bounds"
        );
        require!(
            self.repair_cost_per_point.0 <= 10_000 * COIN,
            "repair price out of bounds"
        );
        require!(
            self.buy_car_cost.0 <= 1_000_000 * COIN,
            "car price out of bounds"
        );
        require!(
            self.tier_upgrade_costs
                .iter()
                .all(|value| value.0 <= 1_000_000 * COIN),
            "tier upgrade price out of bounds"
        );
        require!(
            self.building_upgrade_costs
                .iter()
                .all(|value| value.0 <= 10_000_000 * COIN),
            "building upgrade price out of bounds"
        );
        require!(
            self.change_building_type_cost.0 <= 1_000_000 * COIN,
            "type change price out of bounds"
        );
        require!(
            self.burger_decal_cost.0 <= 1_000_000 * COIN,
            "burger price out of bounds"
        );
        require!(
            self.rule_delay_seconds <= 86_400 && self.ticket_cooldown_seconds <= 86_400,
            "rule or ticket delay out of bounds"
        );
        require!(
            self.inspector_min_age_seconds <= 86_400,
            "inspector age out of bounds"
        );
        require!(
            self.inspector_window_seconds <= 86_400
                && self.inspector_max_attempts_per_window <= 100,
            "inspector patrol limit out of bounds"
        );
        require!(
            self.logo_cooldown_seconds <= 604_800
                && self.facade_cooldown_seconds <= 604_800
                && self.emergency_repair_cooldown_seconds <= 604_800,
            "appearance or repair cooldown out of bounds"
        );
        require!(
            self.corner_price_bps >= 10_000 && self.corner_price_bps <= 50_000,
            "corner price out of bounds"
        );
        require!(self.tower_capacity == 32, "V1 towers have 32 spaces");
        require!(
            self.inspector_window_seconds >= 60 && self.inspector_max_attempts_per_window > 0,
            "invalid inspector patrol limit"
        );
        require!(
            self.plot_base_price_yocto.0 > 0
                && self.plot_base_price_yocto.0 <= 100_000_000_000_000_000_000_000_000,
            "plot price out of bounds"
        );
    }
}

#[cfg(not(feature = "migration-types"))]
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    admin: AccountId,
    moderator: AccountId,
    inspector: AccountId,
    config: GameConfig,
    paused: bool,
    accounts: LookupMap<AccountId, AccountState>,
    cars: LookupMap<u64, Car>,
    next_car_id: u64,
    plots: LookupMap<String, Plot>,
    plot_ids: LookupMap<u16, String>,
    plot_count: u16,
    npc_sites: LookupMap<String, NPCSite>,
    npc_site_ids: LookupMap<u8, String>,
    npc_site_count: u8,
    sessions: LookupMap<u64, ParkingSession>,
    space_sessions: LookupMap<String, u64>,
    next_session_id: u64,
    treasury_coins: U128,
    inspector_window_until: u64,
    inspector_attempts_in_window: u8,
}

#[cfg(not(feature = "migration-types"))]
#[near]
impl Contract {
    #[init]
    pub fn new(admin: AccountId, moderator: AccountId, inspector: AccountId) -> Self {
        let contract_account = env::current_account_id();
        require!(
            env::predecessor_account_id() == contract_account,
            "contract account must initialize itself"
        );
        require!(
            admin == contract_account,
            "admin must be the contract account"
        );
        let config = GameConfig::default();
        config.validate();
        Self {
            admin,
            moderator,
            inspector,
            config,
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

    pub fn get_config(&self) -> GameConfig {
        self.config.clone()
    }
    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn chain_time_seconds(&self) -> u64 {
        Self::now_seconds()
    }
    pub fn get_treasury_coins(&self) -> U128 {
        self.treasury_coins
    }
    pub fn get_roles(&self) -> (AccountId, AccountId, AccountId) {
        (
            self.admin.clone(),
            self.moderator.clone(),
            self.inspector.clone(),
        )
    }

    pub fn registration_quote(&self) -> U128 {
        U128(self.storage_quote(self.config.account_storage_bytes))
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<AccountState> {
        self.accounts.get(&account_id).cloned()
    }

    pub fn get_car(&self, car_id: u64) -> Option<Car> {
        self.cars.get(&car_id).cloned()
    }

    pub fn get_cars(&self, account_id: AccountId) -> Vec<Car> {
        match self.accounts.get(&account_id) {
            Some(account) => account
                .car_ids
                .iter()
                .filter_map(|id| self.cars.get(id).cloned())
                .collect(),
            None => Vec::new(),
        }
    }

    pub fn plot_count(&self) -> u16 {
        self.plot_count
    }

    pub fn npc_site_count(&self) -> u8 {
        self.npc_site_count
    }

    pub fn get_npc_site(&self, site_id: String) -> Option<NPCSite> {
        self.npc_sites.get(&site_id).cloned()
    }

    pub fn get_npc_sites(&self, from_index: u8, limit: u8) -> Vec<NPCSite> {
        require!(limit <= 20, "NPC site page limit exceeds 20");
        let end = self.npc_site_count.min(from_index.saturating_add(limit));
        (from_index..end)
            .filter_map(|index| {
                self.npc_site_ids
                    .get(&index)
                    .and_then(|id| self.npc_sites.get(id).cloned())
            })
            .collect()
    }

    pub fn get_plot(&self, plot_id: String) -> Option<PlotView> {
        self.plots.get(&plot_id).cloned().map(|plot| {
            let effective_rule = plot.effective_rule(Self::now_seconds());
            PlotView {
                logo_eligible: plot.logo.eligible(plot.building.layout_revision),
                billboard_eligible: plot.billboard.eligible(plot.building.layout_revision),
                plot,
                effective_rule,
            }
        })
    }

    pub fn get_plots(&self, from_index: u16, limit: u8) -> Vec<PlotView> {
        require!(limit <= 50, "plot page limit exceeds 50");
        let end = self
            .plot_count
            .min(from_index.saturating_add(u16::from(limit)));
        (from_index..end)
            .filter_map(|index| {
                self.plot_ids
                    .get(&index)
                    .and_then(|id| self.get_plot(id.clone()))
            })
            .collect()
    }

    pub fn get_street_side(&self, road_id: RoadId, side: Side) -> StreetSideView {
        let plots = (0..8)
            .filter_map(|index| {
                let id = format!("plot-{}-{}-{index}", road_id.as_str(), side.short());
                self.get_plot(id.clone()).map(|plot| {
                    let slots = [
                        self.get_space_session(id.clone(), 0),
                        self.get_space_session(id, 1),
                    ];
                    let car_appearances = std::array::from_fn(|slot| {
                        slots[slot].as_ref().and_then(|session| {
                            self.cars.get(&session.car_id).and_then(|car| {
                                (car.parked_session_id == Some(session.id)).then_some(
                                    ParkedCarAppearance {
                                        id: car.id,
                                        body: car.body,
                                        color: car.color,
                                    },
                                )
                            })
                        })
                    });
                    StreetPlotView {
                        plot,
                        slots,
                        car_appearances,
                    }
                })
            })
            .collect();
        StreetSideView {
            road_id,
            side,
            plots,
        }
    }

    pub fn get_session(&self, session_id: u64) -> Option<ParkingSession> {
        self.sessions.get(&session_id).cloned()
    }

    pub fn get_space_session(&self, plot_id: String, slot: u8) -> Option<ParkingSession> {
        if slot > 1 {
            return None;
        }
        self.space_sessions
            .get(&Self::space_key(Facility::Curb, &plot_id, slot))
            .and_then(|id| self.get_session(*id))
    }

    pub fn get_tower_space_session(&self, site_id: String, space: u8) -> Option<ParkingSession> {
        let site = self.npc_sites.get(&site_id)?;
        if site.role != ServiceRole::ParkingTower || space >= site.capacity {
            return None;
        }
        self.space_sessions
            .get(&Self::space_key(Facility::Tower, &site_id, space))
            .and_then(|id| self.get_session(*id))
    }

    pub fn get_tower_floor_sessions(
        &self,
        site_id: String,
        floor: u8,
    ) -> Vec<Option<ParkingSession>> {
        let site = self
            .npc_sites
            .get(&site_id)
            .unwrap_or_else(|| env::panic_str("unknown NPC site"));
        require!(
            site.role == ServiceRole::ParkingTower,
            "NPC site is not a parking tower"
        );
        require!(
            site.capacity % TOWER_SPACES_PER_FLOOR == 0,
            "tower floor layout is invalid"
        );
        require!(
            floor < site.capacity / TOWER_SPACES_PER_FLOOR,
            "invalid tower floor"
        );
        (floor * TOWER_SPACES_PER_FLOOR..(floor + 1) * TOWER_SPACES_PER_FLOOR)
            .map(|space| self.get_tower_space_session(site_id.clone(), space))
            .collect()
    }

    pub fn get_tower_availability(&self, site_id: String) -> u8 {
        let site = self
            .npc_sites
            .get(&site_id)
            .unwrap_or_else(|| env::panic_str("unknown NPC site"));
        require!(
            site.role == ServiceRole::ParkingTower,
            "NPC site is not a parking tower"
        );
        let now = Self::now_seconds();
        let occupied = (0..site.capacity)
            .filter(|space| {
                let key = Self::space_key(Facility::Tower, &site_id, *space);
                self.space_sessions
                    .get(&key)
                    .and_then(|id| self.sessions.get(id))
                    .is_some_and(|session| now < session.expires_at)
            })
            .count();
        site.capacity
            - u8::try_from(occupied).unwrap_or_else(|_| env::panic_str("tower occupancy overflow"))
    }

    pub fn get_tower_open_space(&self, site_id: String) -> Option<u8> {
        let site = self
            .npc_sites
            .get(&site_id)
            .unwrap_or_else(|| env::panic_str("unknown NPC site"));
        require!(
            site.role == ServiceRole::ParkingTower,
            "NPC site is not a parking tower"
        );
        let now = Self::now_seconds();
        (0..site.capacity).find(|space| {
            let key = Self::space_key(Facility::Tower, &site_id, *space);
            self.space_sessions
                .get(&key)
                .and_then(|id| self.sessions.get(id))
                .is_none_or(|session| now >= session.expires_at)
        })
    }

    pub fn get_tower_floor_availability(&self, site_id: String) -> Vec<u8> {
        let site = self
            .npc_sites
            .get(&site_id)
            .unwrap_or_else(|| env::panic_str("unknown NPC site"));
        require!(
            site.role == ServiceRole::ParkingTower,
            "NPC site is not a parking tower"
        );
        require!(
            site.capacity % TOWER_SPACES_PER_FLOOR == 0,
            "tower floor layout is invalid"
        );
        let now = Self::now_seconds();
        (0..site.capacity / TOWER_SPACES_PER_FLOOR)
            .map(|floor| {
                (floor * TOWER_SPACES_PER_FLOOR..(floor + 1) * TOWER_SPACES_PER_FLOOR)
                    .filter(|space| {
                        let key = Self::space_key(Facility::Tower, &site_id, *space);
                        self.space_sessions
                            .get(&key)
                            .and_then(|id| self.sessions.get(id))
                            .is_none_or(|session| now >= session.expires_at)
                    })
                    .count() as u8
            })
            .collect()
    }

    pub fn get_tower_open_space_on_floor(&self, site_id: String, floor: u8) -> Option<u8> {
        let site = self
            .npc_sites
            .get(&site_id)
            .unwrap_or_else(|| env::panic_str("unknown NPC site"));
        require!(
            site.role == ServiceRole::ParkingTower,
            "NPC site is not a parking tower"
        );
        require!(
            site.capacity % TOWER_SPACES_PER_FLOOR == 0,
            "tower floor layout is invalid"
        );
        require!(
            floor < site.capacity / TOWER_SPACES_PER_FLOOR,
            "invalid tower floor"
        );
        let now = Self::now_seconds();
        (floor * TOWER_SPACES_PER_FLOOR..(floor + 1) * TOWER_SPACES_PER_FLOOR).find(|space| {
            let key = Self::space_key(Facility::Tower, &site_id, *space);
            self.space_sessions
                .get(&key)
                .and_then(|id| self.sessions.get(id))
                .is_none_or(|session| now >= session.expires_at)
        })
    }

    pub fn plot_purchase_quote(&self, plot_id: String) -> U128 {
        self.plot_purchase_breakdown(plot_id).total_yocto
    }

    pub fn plot_purchase_breakdown(&self, plot_id: String) -> PlotPurchaseBreakdown {
        let plot = self
            .plots
            .get(&plot_id)
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        require!(plot.owner.is_none(), "plot already owned");
        let price = self.plot_price(plot.corner);
        let storage_reserve = self.storage_quote(self.config.plot_storage_bytes);
        let total = price
            .checked_add(storage_reserve)
            .unwrap_or_else(|| env::panic_str("plot quote overflow"));
        PlotPurchaseBreakdown {
            price_yocto: U128(price),
            storage_reserve_yocto: U128(storage_reserve),
            total_yocto: U128(total),
        }
    }

    #[payable]
    pub fn seed_plot(&mut self, seed: PlotSeed) -> Plot {
        self.require_admin();
        self.require_not_paused();
        require!(seed.index < 8, "plot index must be 0 through 7");
        require!(
            seed.variant == 1 || seed.variant == 2,
            "building variant must be 1 or 2"
        );
        let id = seed.id();
        let caller = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        if let Some(existing) = self.plots.get(&id).cloned() {
            require!(
                existing.road_id == seed.road_id
                    && existing.side == seed.side
                    && existing.index == seed.index,
                "seed conflicts with existing plot"
            );
            self.refund_excess(caller, deposit, 0);
            return existing;
        }
        require!(self.plot_count < 80, "city already has 80 player plots");
        let plot = Plot {
            id: id.clone(),
            road_id: seed.road_id,
            side: seed.side,
            index: seed.index,
            corner: seed.index == 0 || seed.index == 7,
            owner: None,
            rule: ParkingRule::Free,
            pending_rule: None,
            building: BuildingState {
                building_type: seed.building_type,
                variant: seed.variant,
                level: 1,
                primary_color: "#F6C85F".to_string(),
                name: format!("Plot {}", seed.index + 1),
                approved_manifest_hash: None,
                approved_at: None,
                last_facade_approved_at: None,
                pending_appearance: None,
                last_appearance_decision: None,
                facade_exemption_level: None,
                appearance_revision: 1,
                layout_revision: 1,
            },
            logo: MediaSlot::default(),
            billboard: MediaSlot::default(),
            ticket_cooldown_until: 0,
            reserved_storage_bytes: 0,
            used_storage_bytes: 0,
        };
        let before = env::storage_usage();
        self.plots.insert(id.clone(), plot.clone());
        self.plot_ids.insert(self.plot_count, id.clone());
        self.plot_count = self
            .plot_count
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("plot count overflow"));
        self.plots.flush();
        self.plot_ids.flush();
        let cost = self.storage_quote(Self::storage_delta(before));
        require!(deposit >= cost, "insufficient admin plot storage deposit");
        self.refund_excess(caller, deposit, cost);
        self.emit("plot_seeded", near_sdk::serde_json::json!({"plot_id": id}));
        plot
    }

    #[payable]
    pub fn seed_npc_site(&mut self, seed: NPCSiteSeed) -> NPCSite {
        self.require_admin();
        self.require_not_paused();
        require!(
            seed.id.starts_with("npc-")
                && seed.id.len() <= 40
                && seed
                    .id
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'),
            "invalid NPC site ID"
        );
        require!(
            !seed.name.is_empty() && seed.name.chars().count() <= 40,
            "invalid NPC site name"
        );
        require!(
            (8..=11).contains(&seed.frontage_index),
            "NPC frontage must be 8 through 11"
        );
        require!(
            (seed.role == ServiceRole::ParkingTower && seed.capacity == self.config.tower_capacity)
                || (seed.role != ServiceRole::ParkingTower && seed.capacity == 0),
            "invalid NPC capacity"
        );
        let caller = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        if let Some(existing) = self.npc_sites.get(&seed.id).cloned() {
            require!(
                existing.road_id == seed.road_id
                    && existing.side == seed.side
                    && existing.frontage_index == seed.frontage_index
                    && existing.role == seed.role
                    && existing.capacity == seed.capacity
                    && existing.name == seed.name,
                "seed conflicts with existing NPC site"
            );
            self.refund_excess(caller, deposit, 0);
            return existing;
        }
        require!(self.npc_site_count < 7, "city already has seven NPC sites");
        for index in 0..self.npc_site_count {
            let id = self
                .npc_site_ids
                .get(&index)
                .unwrap_or_else(|| env::panic_str("NPC site index missing"));
            let site = self
                .npc_sites
                .get(id)
                .unwrap_or_else(|| env::panic_str("NPC site missing"));
            require!(
                site.road_id != seed.road_id
                    || site.side != seed.side
                    || site.frontage_index != seed.frontage_index,
                "NPC frontage already occupied"
            );
        }
        let site = NPCSite {
            id: seed.id.clone(),
            road_id: seed.road_id,
            side: seed.side,
            frontage_index: seed.frontage_index,
            role: seed.role,
            name: seed.name,
            capacity: seed.capacity,
        };
        let before = env::storage_usage();
        self.npc_sites.insert(seed.id.clone(), site.clone());
        self.npc_site_ids
            .insert(self.npc_site_count, seed.id.clone());
        self.npc_site_count = self
            .npc_site_count
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("NPC site count overflow"));
        self.npc_sites.flush();
        self.npc_site_ids.flush();
        let cost = self.storage_quote(Self::storage_delta(before));
        require!(deposit >= cost, "insufficient admin NPC storage deposit");
        self.refund_excess(caller, deposit, cost);
        self.emit(
            "npc_site_seeded",
            near_sdk::serde_json::json!({"site_id": site.id, "role": "game_owned"}),
        );
        site
    }

    #[payable]
    pub fn buy_plot(&mut self, plot_id: String) -> Plot {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        self.registered_account(&caller);
        let mut plot = self
            .plots
            .get(&plot_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        require!(plot.owner.is_none(), "plot already owned");
        let price = self.plot_price(plot.corner);
        let reserve = self.storage_quote(self.config.plot_storage_bytes);
        let required = price
            .checked_add(reserve)
            .unwrap_or_else(|| env::panic_str("plot purchase price overflow"));
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= required, "insufficient plot purchase deposit");
        let before = env::storage_usage();
        plot.owner = Some(caller.clone());
        plot.reserved_storage_bytes = self.config.plot_storage_bytes;
        self.plots.insert(plot_id.clone(), plot.clone());
        self.plots.flush();
        let used = Self::storage_delta(before);
        require!(
            used <= plot.reserved_storage_bytes,
            "plot ownership exceeds storage reserve"
        );
        plot.used_storage_bytes = used;
        self.plots.insert(plot_id.clone(), plot.clone());
        self.plots.flush();
        self.refund_excess(caller.clone(), deposit, required);
        self.emit("plot_bought", near_sdk::serde_json::json!({"plot_id": plot_id, "owner": caller, "price_yocto": price.to_string()}));
        plot
    }

    pub fn set_rule(&mut self, plot_id: String, rule: ParkingRule) -> PlotView {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut plot = self
            .plots
            .get(&plot_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        require!(plot.owner.as_ref() == Some(&caller), "plot owner only");
        if let ParkingRule::Meter { rate_per_hour } = &rule {
            require!(
                rate_per_hour.0 <= self.config.meter_rate_max_per_hour.0,
                "meter rate exceeds maximum"
            );
        }
        let now = Self::now_seconds();
        plot.promote_pending(now);
        let effective_at = now
            .checked_add(u64::from(self.config.rule_delay_seconds))
            .unwrap_or_else(|| env::panic_str("rule effective time overflow"));
        plot.pending_rule = Some(PendingRule { rule, effective_at });
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit(
            "rule_scheduled",
            near_sdk::serde_json::json!({"plot_id": plot_id, "effective_at": effective_at}),
        );
        PlotView {
            logo_eligible: plot.logo.eligible(plot.building.layout_revision),
            billboard_eligible: plot.billboard.eligible(plot.building.layout_revision),
            effective_rule: plot.effective_rule(now),
            plot,
        }
    }

    pub fn choose_preset(
        &mut self,
        plot_id: String,
        variant: u8,
        primary_color: String,
        name: String,
    ) -> Plot {
        self.require_not_paused();
        Self::validate_building_choices(variant, &primary_color, &name);
        let caller = env::predecessor_account_id();
        let mut plot = self.owned_plot(&plot_id, &caller);
        let building = &mut plot.building;
        if building.variant == variant
            && building.primary_color == primary_color
            && building.name == name
            && building.approved_manifest_hash.is_none()
            && building.pending_appearance.is_none()
        {
            return plot;
        }
        building.variant = variant;
        building.primary_color = primary_color;
        building.name = name;
        Self::activate_preset(building, Self::now_seconds(), "Preset selected");
        Self::advance_layout(&mut plot, Self::now_seconds());
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit("building_updated", near_sdk::serde_json::json!({"plot_id": plot_id, "revision": plot.building.appearance_revision, "change": "preset"}));
        plot
    }

    pub fn change_building_type(
        &mut self,
        plot_id: String,
        building_type: BuildingType,
        variant: u8,
    ) -> Plot {
        self.require_not_paused();
        require!(
            variant == 1 || variant == 2,
            "building variant must be 1 or 2"
        );
        let caller = env::predecessor_account_id();
        let mut plot = self.owned_plot(&plot_id, &caller);
        require!(
            plot.building.building_type != building_type,
            "building already has this type"
        );
        self.debit_coins(
            &caller,
            self.config.change_building_type_cost.0,
            "insufficient coins for building type",
        );
        plot.building.building_type = building_type;
        plot.building.variant = variant;
        Self::activate_preset(
            &mut plot.building,
            Self::now_seconds(),
            "Building type changed",
        );
        Self::advance_layout(&mut plot, Self::now_seconds());
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit("building_updated", near_sdk::serde_json::json!({"plot_id": plot_id, "revision": plot.building.appearance_revision, "change": "type", "cost": self.config.change_building_type_cost.0.to_string()}));
        plot
    }

    pub fn upgrade_building(&mut self, plot_id: String) -> Plot {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut plot = self.owned_plot(&plot_id, &caller);
        let old_level = plot.building.level;
        require!(old_level < 4, "building is already level 4");
        let next_level = old_level
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("building level overflow"));
        let price = self.config.building_upgrade_costs[usize::from(old_level - 1)].0;
        self.debit_coins(&caller, price, "insufficient coins for building upgrade");
        plot.building.level = next_level;
        plot.building.facade_exemption_level = Some(next_level);
        Self::activate_preset(
            &mut plot.building,
            Self::now_seconds(),
            "Building level changed",
        );
        Self::advance_layout(&mut plot, Self::now_seconds());
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit("building_updated", near_sdk::serde_json::json!({"plot_id": plot_id, "revision": plot.building.appearance_revision, "change": "level", "level": next_level, "cost": price.to_string()}));
        plot
    }

    pub fn propose_appearance(
        &mut self,
        plot_id: String,
        expected_revision: u64,
        manifest_hash: String,
    ) -> AppearanceReference {
        self.require_not_paused();
        require!(Self::is_hash(&manifest_hash), "invalid manifest hash");
        let caller = env::predecessor_account_id();
        let mut plot = self.owned_plot(&plot_id, &caller);
        require!(
            plot.building.appearance_revision == expected_revision,
            "stale appearance revision"
        );
        let now = Self::now_seconds();
        Self::reject_pending(&mut plot.building, now, "Superseded");
        let revision = Self::next_appearance_revision(&mut plot.building);
        let reference = AppearanceReference {
            revision,
            owner: caller,
            building_type: plot.building.building_type,
            level: plot.building.level,
            manifest_hash,
        };
        plot.building.pending_appearance = Some(reference.clone());
        self.write_owned_plot(plot_id.clone(), plot);
        self.emit("appearance_proposed", near_sdk::serde_json::json!({"plot_id": plot_id, "revision": reference.revision, "manifest_hash": reference.manifest_hash}));
        reference
    }

    pub fn approve_appearance(&mut self, plot_id: String, expected: AppearanceReference) -> Plot {
        self.require_moderator();
        self.require_not_paused();
        let mut plot = self.pending_appearance_plot(&plot_id, &expected);
        let now = Self::now_seconds();
        if let Some(last) = plot.building.last_facade_approved_at {
            let next = last
                .checked_add(u64::from(self.config.facade_cooldown_seconds))
                .unwrap_or_else(|| env::panic_str("facade cooldown overflow"));
            if now < next {
                require!(
                    plot.building.facade_exemption_level == Some(plot.building.level),
                    "custom facade publication cooldown active"
                );
                plot.building.facade_exemption_level = None;
            }
        }
        plot.building.approved_manifest_hash = Some(expected.manifest_hash.clone());
        plot.building.approved_at = Some(now);
        plot.building.last_facade_approved_at = Some(now);
        plot.building.pending_appearance = None;
        plot.building.last_appearance_decision = Some(AppearanceDecision {
            reference: expected.clone(),
            status: AppearanceStatus::Approved,
            decided_at: now,
            reason: None,
        });
        Self::advance_layout(&mut plot, now);
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit("appearance_approved", near_sdk::serde_json::json!({"plot_id": plot_id, "revision": expected.revision, "manifest_hash": expected.manifest_hash}));
        plot
    }

    pub fn reject_appearance(
        &mut self,
        plot_id: String,
        expected: AppearanceReference,
        reason: String,
    ) -> Plot {
        self.require_moderator();
        self.require_not_paused();
        Self::validate_moderation_reason(&reason);
        let mut plot = self.pending_appearance_plot(&plot_id, &expected);
        plot.building.pending_appearance = None;
        plot.building.last_appearance_decision = Some(AppearanceDecision {
            reference: expected.clone(),
            status: AppearanceStatus::Rejected,
            decided_at: Self::now_seconds(),
            reason: Some(reason),
        });
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit("appearance_rejected", near_sdk::serde_json::json!({"plot_id": plot_id, "revision": expected.revision, "manifest_hash": expected.manifest_hash}));
        plot
    }

    pub fn revoke_appearance(
        &mut self,
        plot_id: String,
        expected_revision: u64,
        expected_manifest_hash: String,
        reason: String,
    ) -> Plot {
        self.require_moderator();
        self.require_not_paused();
        Self::validate_moderation_reason(&reason);
        let mut plot = self
            .plots
            .get(&plot_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        let owner = plot
            .owner
            .clone()
            .unwrap_or_else(|| env::panic_str("unowned plot"));
        require!(
            plot.building.appearance_revision == expected_revision
                && plot.building.approved_manifest_hash.as_deref()
                    == Some(expected_manifest_hash.as_str()),
            "stale or mismatched appearance revocation"
        );
        let now = Self::now_seconds();
        plot.building.pending_appearance = None;
        plot.building.approved_manifest_hash = None;
        plot.building.approved_at = None;
        let revision = Self::next_appearance_revision(&mut plot.building);
        plot.building.last_appearance_decision = Some(AppearanceDecision {
            reference: AppearanceReference {
                revision,
                owner,
                building_type: plot.building.building_type,
                level: plot.building.level,
                manifest_hash: expected_manifest_hash.clone(),
            },
            status: AppearanceStatus::Revoked,
            decided_at: now,
            reason: Some(reason),
        });
        Self::advance_layout(&mut plot, now);
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit("appearance_revoked", near_sdk::serde_json::json!({"plot_id": plot_id, "revision": revision, "manifest_hash": expected_manifest_hash}));
        plot
    }

    pub fn propose_media(
        &mut self,
        plot_id: String,
        kind: MediaKind,
        expected_media_revision: u64,
        expected_layout_revision: u64,
        content: MediaIdentity,
    ) -> MediaProposal {
        self.require_not_paused();
        Self::validate_media_content(&content);
        let caller = env::predecessor_account_id();
        let mut plot = self.owned_plot(&plot_id, &caller);
        require!(
            plot.building.layout_revision == expected_layout_revision,
            "stale building layout revision"
        );
        let building_type = plot.building.building_type;
        let level = plot.building.level;
        let now = Self::now_seconds();
        let slot = Self::media_slot_mut(&mut plot, kind);
        require!(
            slot.revision == expected_media_revision,
            "stale media revision"
        );
        require!(
            !(slot.eligible(expected_layout_revision)
                && slot
                    .active
                    .as_ref()
                    .is_some_and(|active| active.content == content)),
            "media already approved for this layout"
        );
        Self::reject_pending_media(slot, now);
        let revision = Self::next_media_revision(slot);
        let proposal = MediaProposal {
            revision,
            owner: caller,
            building_type,
            level,
            layout_revision: expected_layout_revision,
            content,
        };
        slot.pending = Some(proposal.clone());
        self.write_owned_plot(plot_id.clone(), plot);
        self.emit("media_proposed", near_sdk::serde_json::json!({"plot_id": plot_id, "kind": Self::media_kind_name(kind), "revision": revision, "asset_hash": proposal.content.asset_hash}));
        proposal
    }

    pub fn approve_media(
        &mut self,
        plot_id: String,
        kind: MediaKind,
        expected: MediaProposal,
    ) -> PlotView {
        self.require_moderator();
        self.require_not_paused();
        let mut plot = self.pending_media_plot(&plot_id, kind, &expected);
        let now = Self::now_seconds();
        let slot = Self::media_slot_mut(&mut plot, kind);
        let unchanged = slot
            .active
            .as_ref()
            .is_some_and(|active| active.content == expected.content);
        if !unchanged {
            if let Some(last) = slot.last_replacement_at {
                let next = last
                    .checked_add(u64::from(self.config.logo_cooldown_seconds))
                    .unwrap_or_else(|| env::panic_str("media cooldown overflow"));
                require!(now >= next, "media replacement cooldown active");
            }
            slot.last_replacement_at = Some(now);
        }
        slot.active = Some(MediaApproval {
            content: expected.content.clone(),
            approved_layout_revision: expected.layout_revision,
            approved_at: now,
        });
        slot.pending = None;
        slot.last_decision = Some(MediaDecision {
            proposal: expected.clone(),
            status: MediaDecisionStatus::Approved,
            decided_at: now,
            reason: None,
        });
        self.write_owned_plot(plot_id.clone(), plot);
        self.emit("media_approved", near_sdk::serde_json::json!({"plot_id": plot_id, "kind": Self::media_kind_name(kind), "revision": expected.revision, "asset_hash": expected.content.asset_hash}));
        self.get_plot(plot_id)
            .unwrap_or_else(|| env::panic_str("approved plot missing"))
    }

    pub fn reject_media(
        &mut self,
        plot_id: String,
        kind: MediaKind,
        expected: MediaProposal,
        reason: String,
    ) -> PlotView {
        self.require_moderator();
        self.require_not_paused();
        Self::validate_moderation_reason(&reason);
        let mut plot = self.pending_media_plot(&plot_id, kind, &expected);
        let slot = Self::media_slot_mut(&mut plot, kind);
        slot.pending = None;
        slot.last_decision = Some(MediaDecision {
            proposal: expected.clone(),
            status: MediaDecisionStatus::Rejected,
            decided_at: Self::now_seconds(),
            reason: Some(reason),
        });
        self.write_owned_plot(plot_id.clone(), plot);
        self.emit("media_rejected", near_sdk::serde_json::json!({"plot_id": plot_id, "kind": Self::media_kind_name(kind), "revision": expected.revision, "asset_hash": expected.content.asset_hash}));
        self.get_plot(plot_id)
            .unwrap_or_else(|| env::panic_str("rejected plot missing"))
    }

    pub fn remove_media(
        &mut self,
        plot_id: String,
        kind: MediaKind,
        expected_media_revision: u64,
    ) -> PlotView {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut plot = self.owned_plot(&plot_id, &caller);
        let now = Self::now_seconds();
        let slot = Self::media_slot_mut(&mut plot, kind);
        require!(
            slot.revision == expected_media_revision,
            "stale media revision"
        );
        require!(
            slot.active.is_some() || slot.pending.is_some(),
            "media slot is already empty"
        );
        Self::reject_pending_media(slot, now);
        slot.active = None;
        let revision = Self::next_media_revision(slot);
        self.write_owned_plot(plot_id.clone(), plot);
        self.emit("media_removed", near_sdk::serde_json::json!({"plot_id": plot_id, "kind": Self::media_kind_name(kind), "revision": revision}));
        self.get_plot(plot_id)
            .unwrap_or_else(|| env::panic_str("updated plot missing"))
    }

    pub fn revoke_media(
        &mut self,
        plot_id: String,
        kind: MediaKind,
        expected_media_revision: u64,
        expected_content: MediaIdentity,
        reason: String,
    ) -> PlotView {
        self.require_moderator();
        self.require_not_paused();
        Self::validate_moderation_reason(&reason);
        let mut plot = self
            .plots
            .get(&plot_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        let owner = plot
            .owner
            .clone()
            .unwrap_or_else(|| env::panic_str("unowned plot"));
        let building_type = plot.building.building_type;
        let level = plot.building.level;
        let layout_revision = plot.building.layout_revision;
        let now = Self::now_seconds();
        let slot = Self::media_slot_mut(&mut plot, kind);
        require!(
            slot.revision == expected_media_revision
                && slot
                    .active
                    .as_ref()
                    .is_some_and(|active| active.content == expected_content),
            "stale or mismatched media revocation"
        );
        slot.active = None;
        slot.pending = None;
        let revision = Self::next_media_revision(slot);
        slot.last_decision = Some(MediaDecision {
            proposal: MediaProposal {
                revision,
                owner,
                building_type,
                level,
                layout_revision,
                content: expected_content.clone(),
            },
            status: MediaDecisionStatus::Revoked,
            decided_at: now,
            reason: Some(reason),
        });
        self.write_owned_plot(plot_id.clone(), plot);
        self.emit("media_revoked", near_sdk::serde_json::json!({"plot_id": plot_id, "kind": Self::media_kind_name(kind), "revision": revision, "asset_hash": expected_content.asset_hash}));
        self.get_plot(plot_id)
            .unwrap_or_else(|| env::panic_str("revoked plot missing"))
    }

    pub fn park(&mut self, car_id: u64, plot_id: String, slot: u8) -> ParkingSession {
        self.park_internal(car_id, plot_id, slot, Facility::Curb)
    }

    pub fn park_tower(&mut self, car_id: u64, site_id: String, space: u8) -> ParkingSession {
        self.park_internal(car_id, site_id, space, Facility::Tower)
    }

    fn park_internal(
        &mut self,
        car_id: u64,
        plot_id: String,
        slot: u8,
        facility: Facility,
    ) -> ParkingSession {
        self.require_not_paused();
        match facility {
            Facility::Curb => require!(slot < 2, "curb slot must be 0 or 1"),
            Facility::Tower => {
                let site = self
                    .npc_sites
                    .get(&plot_id)
                    .unwrap_or_else(|| env::panic_str("unknown NPC site"));
                require!(
                    site.role == ServiceRole::ParkingTower,
                    "NPC site is not a parking tower"
                );
                require!(slot < site.capacity, "tower space index out of bounds");
            }
        }
        let caller = env::predecessor_account_id();
        let now = Self::now_seconds();
        let mut account = self.registered_account(&caller);
        if let Some(active_id) = account.active_session_id {
            let active = self
                .sessions
                .get(&active_id)
                .cloned()
                .unwrap_or_else(|| env::panic_str("active session missing"));
            require!(
                now >= active.expires_at,
                "account already has an earning car"
            );
            self.settle_session(active_id, SettlementReason::Expire, None);
            account = self.registered_account(&caller);
        }
        let key = Self::space_key(facility, &plot_id, slot);
        if let Some(existing_id) = self.space_sessions.get(&key).copied() {
            let existing = self
                .sessions
                .get(&existing_id)
                .cloned()
                .unwrap_or_else(|| env::panic_str("occupied session missing"));
            require!(now >= existing.expires_at, "parking space is occupied");
            self.settle_session(existing_id, SettlementReason::Expire, None);
        }
        require!(
            account.active_session_id.is_none(),
            "account already has an earning car"
        );
        require!(
            !self.space_sessions.contains_key(&key),
            "parking space is occupied"
        );
        let mut car = self.owned_car(car_id, &caller);
        require!(car.parked_session_id.is_none(), "car already parked");
        require!(
            car.durability >= self.config.park_durability_cost,
            "car needs repair before parking"
        );
        let (legal, meter_rate, meter_recipient) = match facility {
            Facility::Curb => {
                let plot = self
                    .plots
                    .get(&plot_id)
                    .cloned()
                    .unwrap_or_else(|| env::panic_str("unknown plot"));
                require!(
                    plot.owner.as_ref() != Some(&caller),
                    "cannot earn on your own curb"
                );
                match plot.effective_rule(now) {
                    ParkingRule::Free => (true, U128(0), None),
                    ParkingRule::Meter { rate_per_hour } => {
                        (true, rate_per_hour, plot.owner.clone())
                    }
                    ParkingRule::ColorOnly { color } => (car.color == color, U128(0), None),
                    ParkingRule::NoParking => (false, U128(0), None),
                }
            }
            Facility::Tower => (true, U128(0), None),
        };
        let tier_index = usize::from(
            car.tier
                .checked_sub(1)
                .unwrap_or_else(|| env::panic_str("invalid car tier")),
        );
        let tier_multiplier = *self
            .config
            .tier_multiplier_bps
            .get(tier_index)
            .unwrap_or_else(|| env::panic_str("invalid car tier"));
        let terms = SessionTerms {
            config_version: self.config.version,
            base_rate_per_hour: self.config.base_rate_per_hour,
            tier_multiplier_bps: tier_multiplier,
            legality_multiplier_bps: if legal {
                10_000
            } else {
                self.config.illegal_multiplier_bps
            },
            facility_multiplier_bps: if facility == Facility::Tower {
                self.config.tower_multiplier_bps
            } else {
                10_000
            },
            meter_rate_per_hour: meter_rate,
            earn_cap_seconds: self.config.earn_cap_seconds,
            ticket_recipient_bps: self.config.ticket_recipient_bps,
            meter_recipient,
        };
        let earn_until = now
            .checked_add(u64::from(self.config.earn_cap_seconds))
            .unwrap_or_else(|| env::panic_str("earning deadline overflow"));
        let expires_at = earn_until
            .checked_add(u64::from(self.config.expiry_grace_seconds))
            .unwrap_or_else(|| env::panic_str("expiry deadline overflow"));
        let id = self.next_session_id;
        require!(id <= 9_000_000_000_000_000, "session ID limit reached");
        self.next_session_id = id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("session ID overflow"));
        let session = ParkingSession {
            id,
            car_id,
            driver: caller.clone(),
            location_id: plot_id.clone(),
            slot,
            facility,
            started_at: now,
            earn_until,
            expires_at,
            legal,
            terms,
            inspector_attempted: false,
        };
        car.durability = car
            .durability
            .checked_sub(self.config.park_durability_cost)
            .unwrap_or_else(|| env::panic_str("parking durability underflow"));
        car.parked_session_id = Some(id);
        account.active_session_id = Some(id);
        let before = env::storage_usage();
        self.sessions.insert(id, session.clone());
        self.space_sessions.insert(key, id);
        self.cars.insert(car_id, car);
        self.accounts.insert(caller.clone(), account.clone());
        self.sessions.flush();
        self.space_sessions.flush();
        self.cars.flush();
        self.accounts.flush();
        let growth = Self::storage_delta(before);
        account.used_storage_bytes = account
            .used_storage_bytes
            .checked_add(growth)
            .unwrap_or_else(|| env::panic_str("account storage accounting overflow"));
        require!(
            account.used_storage_bytes <= account.reserved_storage_bytes,
            "parking session exceeds prepaid storage reserve"
        );
        self.accounts.insert(caller.clone(), account);
        self.accounts.flush();
        self.emit("parked", near_sdk::serde_json::json!({"session_id": id, "car_id": car_id, "driver": caller, "location_id": plot_id, "slot": slot, "facility": if facility == Facility::Tower { "Tower" } else { "Curb" }, "legal": legal, "expires_at": expires_at}));
        session
    }

    pub fn collect(&mut self, expected_session_id: u64) -> Settlement {
        let session = self
            .sessions
            .get(&expected_session_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown parking session"));
        require!(
            session.driver == env::predecessor_account_id(),
            "driver only"
        );
        require!(
            Self::now_seconds() < session.expires_at,
            "session expired; call settle_expired"
        );
        self.settle_session(expected_session_id, SettlementReason::Collect, None)
    }

    pub fn settle_expired(&mut self, expected_session_id: u64) -> Settlement {
        let session = self
            .sessions
            .get(&expected_session_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown parking session"));
        require!(
            Self::now_seconds() >= session.expires_at,
            "session has not expired"
        );
        self.settle_session(expected_session_id, SettlementReason::Expire, None)
    }

    pub fn ticket(&mut self, plot_id: String, slot: u8, expected_session_id: u64) -> Settlement {
        require!(slot < 2, "curb slot must be 0 or 1");
        let caller = env::predecessor_account_id();
        let mut plot = self
            .plots
            .get(&plot_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        require!(plot.owner.as_ref() == Some(&caller), "plot owner only");
        let now = Self::now_seconds();
        require!(now >= plot.ticket_cooldown_until, "ticket cooldown active");
        let session = self
            .sessions
            .get(&expected_session_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown parking session"));
        require!(
            session.facility == Facility::Curb
                && session.location_id == plot_id
                && session.slot == slot,
            "session is not in requested space"
        );
        require!(
            self.space_sessions
                .get(&Self::space_key(Facility::Curb, &plot_id, slot))
                == Some(&expected_session_id),
            "stale parking session"
        );
        require!(!session.legal, "legal parking cannot be ticketed");
        require!(
            now < session.expires_at,
            "session expired; call settle_expired"
        );
        require!(session.driver != caller, "cannot ticket your own car");
        let cooldown_until = now
            .checked_add(u64::from(self.config.ticket_cooldown_seconds))
            .unwrap_or_else(|| env::panic_str("ticket cooldown overflow"));
        let settlement =
            self.settle_session(expected_session_id, SettlementReason::Ticket, Some(caller));
        plot.ticket_cooldown_until = cooldown_until;
        self.plots.insert(plot_id, plot);
        settlement
    }

    pub fn inspect(
        &mut self,
        plot_id: String,
        slot: u8,
        expected_session_id: u64,
    ) -> Option<Settlement> {
        require!(
            env::predecessor_account_id() == self.inspector,
            "inspector only"
        );
        require!(slot < 2, "curb slot must be 0 or 1");
        let now = Self::now_seconds();
        let mut session = self
            .sessions
            .get(&expected_session_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown parking session"));
        require!(
            session.facility == Facility::Curb
                && session.location_id == plot_id
                && session.slot == slot,
            "session is not in requested space"
        );
        require!(
            self.space_sessions
                .get(&Self::space_key(Facility::Curb, &plot_id, slot))
                == Some(&expected_session_id),
            "stale parking session"
        );
        require!(!session.legal, "legal parking cannot be inspected");
        require!(
            now < session.expires_at,
            "session expired; call settle_expired"
        );
        require!(
            !session.inspector_attempted,
            "inspector already attempted this session"
        );
        require!(
            now.saturating_sub(session.started_at)
                >= u64::from(self.config.inspector_min_age_seconds),
            "illegal session is too new to inspect"
        );
        if now >= self.inspector_window_until {
            self.inspector_window_until = now
                .checked_add(u64::from(self.config.inspector_window_seconds))
                .unwrap_or_else(|| env::panic_str("inspector window overflow"));
            self.inspector_attempts_in_window = 0;
        }
        require!(
            self.inspector_attempts_in_window < self.config.inspector_max_attempts_per_window,
            "inspector patrol limit reached"
        );
        self.inspector_attempts_in_window = self
            .inspector_attempts_in_window
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("inspector attempt overflow"));
        session.inspector_attempted = true;
        self.sessions.insert(expected_session_id, session);
        let roll = Self::inspection_roll(&env::random_seed(), expected_session_id);
        let success = roll < u64::from(self.config.inspector_chance_bps);
        self.emit(
            "inspection_attempted",
            near_sdk::serde_json::json!({"session_id": expected_session_id, "success": success}),
        );
        if success {
            Some(self.settle_session(expected_session_id, SettlementReason::Ticket, None))
        } else {
            None
        }
    }

    fn inspection_roll(seed: &[u8], session_id: u64) -> u64 {
        require!(seed.len() == 32, "random seed must be 32 bytes");
        let mut input = Vec::with_capacity(b"near.estate:inspect:v1".len() + 40);
        input.extend_from_slice(b"near.estate:inspect:v1");
        input.extend_from_slice(seed);
        input.extend_from_slice(&session_id.to_le_bytes());
        let digest = env::sha256(&input);
        let mut bytes = [0u8; 8];
        bytes.copy_from_slice(&digest[..8]);
        u64::from_le_bytes(bytes) % 10_000
    }

    #[payable]
    pub fn register_player(&mut self, body: CarBody, color: CarColor) -> Car {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        require!(
            !self.accounts.contains_key(&caller),
            "player already registered"
        );
        let quote = self.registration_quote().0;
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            deposit >= quote,
            "insufficient registration storage deposit"
        );
        let car_id = self.take_car_id();
        let car = Car {
            id: car_id,
            owner: caller.clone(),
            body,
            color,
            tier: 1,
            durability: self.config.max_durability,
            parked_session_id: None,
        };
        let account = AccountState {
            balance: self.config.starter_coins,
            car_ids: vec![car_id],
            starter_car_id: car_id,
            active_session_id: None,
            last_emergency_repair_at: None,
            burger_decal: false,
            reserved_storage_bytes: self.config.account_storage_bytes,
            used_storage_bytes: 0,
        };
        let before = env::storage_usage();
        self.accounts.insert(caller.clone(), account.clone());
        self.cars.insert(car_id, car.clone());
        self.accounts.flush();
        self.cars.flush();
        let used = Self::storage_delta(before);
        require!(
            used <= account.reserved_storage_bytes,
            "registration exceeds reserved storage"
        );
        let mut account = account;
        account.used_storage_bytes = used;
        self.accounts.insert(caller.clone(), account);
        self.accounts.flush();
        self.refund_excess(caller.clone(), deposit, quote);
        self.emit(
            "player_registered",
            near_sdk::serde_json::json!({"account_id": caller, "starter_car_id": car_id, "grant": self.config.starter_coins.0.to_string()}),
        );
        self.emit(
            "car_minted",
            near_sdk::serde_json::json!({"car_id": car_id, "owner": caller, "source": "starter", "cost": "0"}),
        );
        car
    }

    pub fn buy_car(&mut self, body: CarBody, color: CarColor) -> Car {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut account = self.registered_account(&caller);
        require!(
            account.car_ids.len() < usize::from(self.config.max_cars),
            "three-car limit reached"
        );
        account.balance.0 = account
            .balance
            .0
            .checked_sub(self.config.buy_car_cost.0)
            .unwrap_or_else(|| env::panic_str("insufficient coins for car"));
        let car_id = self.take_car_id();
        let car = Car {
            id: car_id,
            owner: caller.clone(),
            body,
            color,
            tier: 1,
            durability: self.config.max_durability,
            parked_session_id: None,
        };
        account.car_ids.push(car_id);
        let before = env::storage_usage();
        self.accounts.insert(caller.clone(), account.clone());
        self.cars.insert(car_id, car.clone());
        self.accounts.flush();
        self.cars.flush();
        let used = Self::storage_delta(before);
        account.used_storage_bytes = account
            .used_storage_bytes
            .checked_add(used)
            .unwrap_or_else(|| env::panic_str("storage usage overflow"));
        require!(
            account.used_storage_bytes <= account.reserved_storage_bytes,
            "car exceeds prepaid storage reserve"
        );
        self.accounts.insert(caller.clone(), account);
        self.accounts.flush();
        self.emit(
            "car_minted",
            near_sdk::serde_json::json!({"car_id": car_id, "owner": caller, "source": "purchase", "cost": self.config.buy_car_cost.0.to_string()}),
        );
        car
    }

    pub fn repair(&mut self, car_id: u64, points: u8) -> Car {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut account = self.registered_account(&caller);
        let mut car = self.owned_car(car_id, &caller);
        require!(car.parked_session_id.is_none(), "collect car before repair");
        require!(points > 0, "repair points must be positive");
        let new_durability = car
            .durability
            .checked_add(points)
            .unwrap_or_else(|| env::panic_str("repair exceeds maximum durability"));
        require!(
            new_durability <= self.config.max_durability,
            "repair exceeds maximum durability"
        );
        let cost = self
            .config
            .repair_cost_per_point
            .0
            .checked_mul(u128::from(points))
            .unwrap_or_else(|| env::panic_str("repair price overflow"));
        account.balance.0 = account
            .balance
            .0
            .checked_sub(cost)
            .unwrap_or_else(|| env::panic_str("insufficient coins for repair"));
        car.durability = new_durability;
        self.accounts.insert(caller, account);
        self.cars.insert(car_id, car.clone());
        self.emit("car_repaired", near_sdk::serde_json::json!({"car_id": car_id, "points": points, "cost": cost.to_string()}));
        car
    }

    pub fn upgrade_car(&mut self, car_id: u64) -> Car {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut account = self.registered_account(&caller);
        let mut car = self.owned_car(car_id, &caller);
        require!(
            car.parked_session_id.is_none(),
            "collect car before upgrade"
        );
        require!(car.tier < 3, "car already at maximum tier");
        let price = self.config.tier_upgrade_costs[usize::from(car.tier - 1)].0;
        account.balance.0 = account
            .balance
            .0
            .checked_sub(price)
            .unwrap_or_else(|| env::panic_str("insufficient coins for upgrade"));
        car.tier = car
            .tier
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("car tier overflow"));
        self.accounts.insert(caller, account);
        self.cars.insert(car_id, car.clone());
        self.emit("car_upgraded", near_sdk::serde_json::json!({"car_id": car_id, "tier": car.tier, "cost": price.to_string()}));
        car
    }

    pub fn emergency_repair(&mut self) -> Car {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut account = self.registered_account(&caller);
        let park_cost = self.config.park_durability_cost;
        require!(
            account.active_session_id.is_none(),
            "cannot emergency repair while parked"
        );
        let mut fewest_missing_points = park_cost;
        for car_id in &account.car_ids {
            let car = self.owned_car(*car_id, &caller);
            require!(
                car.durability < park_cost,
                "a car still has parking durability"
            );
            fewest_missing_points = fewest_missing_points.min(park_cost - car.durability);
        }
        let cheapest_repair = self
            .config
            .repair_cost_per_point
            .0
            .checked_mul(u128::from(fewest_missing_points))
            .unwrap_or_else(|| env::panic_str("emergency repair price overflow"));
        require!(
            account.balance.0 < cheapest_repair,
            "can afford a repair to parking durability"
        );
        let now = env::block_timestamp_ms() / 1_000;
        if let Some(last) = account.last_emergency_repair_at {
            let eligible_at = last
                .checked_add(u64::from(self.config.emergency_repair_cooldown_seconds))
                .unwrap_or_else(|| env::panic_str("emergency repair time overflow"));
            require!(now >= eligible_at, "emergency repair cooldown active");
        }
        let mut car = self.owned_car(account.starter_car_id, &caller);
        let points = park_cost
            .checked_sub(car.durability)
            .unwrap_or_else(|| env::panic_str("starter car already has parking durability"));
        car.durability = park_cost;
        account.last_emergency_repair_at = Some(now);
        self.accounts.insert(caller, account);
        self.cars.insert(car.id, car.clone());
        self.emit(
            "car_repaired",
            near_sdk::serde_json::json!({"car_id": car.id, "points": points, "emergency": true}),
        );
        car
    }

    pub fn buy_cosmetic(&mut self) {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut account = self.registered_account(&caller);
        require!(!account.burger_decal, "burger decal already owned");
        account.balance.0 = account
            .balance
            .0
            .checked_sub(self.config.burger_decal_cost.0)
            .unwrap_or_else(|| env::panic_str("insufficient coins for burger decal"));
        account.burger_decal = true;
        self.accounts.insert(caller.clone(), account);
        self.emit(
            "cosmetic_bought",
            near_sdk::serde_json::json!({"account_id": caller, "cosmetic": "burger_decal", "cost": self.config.burger_decal_cost.0.to_string()}),
        );
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.require_admin();
        self.paused = paused;
    }

    pub fn update_config(&mut self, config: GameConfig) {
        self.require_admin();
        self.require_not_paused();
        let next_version = match self.config.version.checked_add(1) {
            Some(value) => value,
            None => env::panic_str("config version overflow"),
        };
        require!(
            config.version == next_version,
            "config version must increase by one"
        );
        config.validate();
        self.config = config;
        self.emit(
            "config_updated",
            near_sdk::serde_json::json!({"version": self.config.version}),
        );
    }

    fn require_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "admin only");
    }

    fn require_moderator(&self) {
        require!(
            env::predecessor_account_id() == self.moderator,
            "moderator only"
        );
    }

    fn require_not_paused(&self) {
        require!(!self.paused, "new game changes are paused");
    }

    fn owned_plot(&self, plot_id: &str, caller: &AccountId) -> Plot {
        let plot = self
            .plots
            .get(&plot_id.to_string())
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        require!(plot.owner.as_ref() == Some(caller), "plot owner only");
        plot
    }

    fn debit_coins(&mut self, caller: &AccountId, amount: u128, error: &str) {
        let mut account = self.registered_account(caller);
        account.balance.0 = account
            .balance
            .0
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str(error));
        self.accounts.insert(caller.clone(), account);
        self.accounts.flush();
    }

    fn validate_building_choices(variant: u8, primary_color: &str, name: &str) {
        require!(
            variant == 1 || variant == 2,
            "building variant must be 1 or 2"
        );
        require!(
            matches!(primary_color, "#EF8270" | "#69B9E9" | "#73D9A6" | "#F6C85F"),
            "building colour is not in the preset palette"
        );
        require!(
            !name.trim().is_empty()
                && name.chars().count() <= 24
                && name.chars().all(|character| !character.is_control()),
            "invalid building name"
        );
    }

    fn is_hash(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }

    fn validate_media_content(content: &MediaIdentity) {
        require!(
            Self::is_hash(&content.asset_hash),
            "invalid media asset hash"
        );
        if let Some(link) = &content.link {
            require!(
                link.len() <= 256
                    && link.starts_with("https://")
                    && link.bytes().all(|byte| {
                        byte.is_ascii_graphic()
                            && !matches!(byte, b'@' | b'\\' | b'"' | b'\'' | b'<' | b'>')
                    }),
                "invalid media HTTPS link"
            );
            let authority = link[8..].split(['/', '?', '#']).next().unwrap_or("");
            require!(
                authority.contains('.')
                    && authority.len() <= 253
                    && authority.split('.').all(|label| {
                        !label.is_empty()
                            && label.len() <= 63
                            && label
                                .bytes()
                                .next()
                                .is_some_and(|byte| byte.is_ascii_alphanumeric())
                            && label
                                .bytes()
                                .last()
                                .is_some_and(|byte| byte.is_ascii_alphanumeric())
                            && label
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                    }),
                "invalid media HTTPS host"
            );
        }
    }

    fn validate_moderation_reason(reason: &str) {
        require!(
            !reason.trim().is_empty() && reason.len() <= MAX_MODERATION_REASON_BYTES,
            "invalid moderation reason"
        );
    }

    fn media_kind_name(kind: MediaKind) -> &'static str {
        match kind {
            MediaKind::Logo => "Logo",
            MediaKind::Billboard => "Billboard",
        }
    }

    fn next_media_revision(slot: &mut MediaSlot) -> u64 {
        let next = slot
            .revision
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("media revision overflow"));
        require!(
            next <= 9_000_000_000_000_000,
            "media revision limit reached"
        );
        slot.revision = next;
        next
    }

    fn next_appearance_revision(building: &mut BuildingState) -> u64 {
        let next = building
            .appearance_revision
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("appearance revision overflow"));
        require!(
            next <= 9_000_000_000_000_000,
            "appearance revision limit reached"
        );
        building.appearance_revision = next;
        next
    }

    fn reject_pending(building: &mut BuildingState, now: u64, reason: &str) {
        if let Some(reference) = building.pending_appearance.take() {
            building.last_appearance_decision = Some(AppearanceDecision {
                reference,
                status: AppearanceStatus::Rejected,
                decided_at: now,
                reason: Some(reason.to_string()),
            });
        }
    }

    fn activate_preset(building: &mut BuildingState, now: u64, reason: &str) {
        Self::reject_pending(building, now, reason);
        building.approved_manifest_hash = None;
        building.approved_at = None;
        Self::next_appearance_revision(building);
    }

    fn advance_layout(plot: &mut Plot, now: u64) {
        plot.building.layout_revision = plot
            .building
            .layout_revision
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("building layout revision overflow"));
        require!(
            plot.building.layout_revision <= 9_000_000_000_000_000,
            "building layout revision limit reached"
        );
        Self::reject_pending_media(&mut plot.logo, now);
        Self::reject_pending_media(&mut plot.billboard, now);
    }

    fn reject_pending_media(slot: &mut MediaSlot, now: u64) {
        if let Some(proposal) = slot.pending.take() {
            slot.last_decision = Some(MediaDecision {
                proposal,
                status: MediaDecisionStatus::Rejected,
                decided_at: now,
                reason: Some("Building layout changed".to_string()),
            });
        }
    }

    fn media_slot(plot: &Plot, kind: MediaKind) -> &MediaSlot {
        match kind {
            MediaKind::Logo => &plot.logo,
            MediaKind::Billboard => &plot.billboard,
        }
    }

    fn media_slot_mut(plot: &mut Plot, kind: MediaKind) -> &mut MediaSlot {
        match kind {
            MediaKind::Logo => &mut plot.logo,
            MediaKind::Billboard => &mut plot.billboard,
        }
    }

    fn pending_media_plot(&self, plot_id: &str, kind: MediaKind, expected: &MediaProposal) -> Plot {
        let plot = self
            .plots
            .get(&plot_id.to_string())
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        let slot = Self::media_slot(&plot, kind);
        require!(
            plot.owner.as_ref() == Some(&expected.owner)
                && plot.building.building_type == expected.building_type
                && plot.building.level == expected.level
                && plot.building.layout_revision == expected.layout_revision
                && slot.revision == expected.revision
                && slot.pending.as_ref() == Some(expected),
            "stale or mismatched media decision"
        );
        plot
    }

    fn pending_appearance_plot(&self, plot_id: &str, expected: &AppearanceReference) -> Plot {
        let plot = self
            .plots
            .get(&plot_id.to_string())
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        require!(
            plot.owner.as_ref() == Some(&expected.owner)
                && plot.building.building_type == expected.building_type
                && plot.building.level == expected.level
                && plot.building.appearance_revision == expected.revision
                && plot.building.pending_appearance.as_ref() == Some(expected),
            "stale or mismatched appearance decision"
        );
        plot
    }

    fn write_owned_plot(&mut self, plot_id: String, mut plot: Plot) -> Plot {
        require!(
            plot.owner.is_some(),
            "unowned plot cannot use owner storage"
        );
        let before = env::storage_usage();
        self.plots.insert(plot_id.clone(), plot.clone());
        self.plots.flush();
        let after = env::storage_usage();
        if after >= before {
            let growth = u32::try_from(after - before)
                .unwrap_or_else(|_| env::panic_str("plot storage growth overflow"));
            plot.used_storage_bytes = plot
                .used_storage_bytes
                .checked_add(growth)
                .unwrap_or_else(|| env::panic_str("plot storage accounting overflow"));
        } else {
            let released = u32::try_from(before - after)
                .unwrap_or_else(|_| env::panic_str("plot storage release overflow"));
            plot.used_storage_bytes = plot.used_storage_bytes.saturating_sub(released);
        }
        require!(
            plot.used_storage_bytes <= plot.reserved_storage_bytes,
            "plot exceeds prepaid storage reserve"
        );
        self.plots.insert(plot_id, plot.clone());
        self.plots.flush();
        plot
    }

    fn settle_session(
        &mut self,
        session_id: u64,
        reason: SettlementReason,
        ticket_recipient: Option<AccountId>,
    ) -> Settlement {
        let session = self
            .sessions
            .get(&session_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown parking session"));
        let key = Self::space_key(session.facility, &session.location_id, session.slot);
        require!(
            self.space_sessions.get(&key) == Some(&session_id),
            "parking occupancy invariant failed"
        );
        let now = Self::now_seconds();
        let settlement = calculate_settlement(&session, now, reason);
        let mut driver = self.registered_account(&session.driver);
        require!(
            driver.active_session_id == Some(session_id),
            "driver active-session invariant failed"
        );
        let mut car = self.owned_car(session.car_id, &session.driver);
        require!(
            car.parked_session_id == Some(session_id),
            "car parking invariant failed"
        );
        driver.balance.0 = driver
            .balance
            .0
            .checked_add(settlement.driver_payout.0)
            .unwrap_or_else(|| env::panic_str("driver balance overflow"));
        driver.active_session_id = None;
        car.parked_session_id = None;
        let recipient = if matches!(reason, SettlementReason::Ticket) {
            ticket_recipient
        } else {
            session.terms.meter_recipient.clone()
        };
        let before = env::storage_usage();
        self.accounts.insert(session.driver.clone(), driver);
        self.cars.insert(session.car_id, car);
        self.sessions.remove(&session_id);
        self.space_sessions.remove(&key);
        if settlement.recipient_payout.0 > 0 {
            if let Some(account_id) = recipient {
                let mut owner = self.registered_account(&account_id);
                owner.balance.0 = owner
                    .balance
                    .0
                    .checked_add(settlement.recipient_payout.0)
                    .unwrap_or_else(|| env::panic_str("recipient balance overflow"));
                self.accounts.insert(account_id, owner);
            } else {
                self.treasury_coins.0 = self
                    .treasury_coins
                    .0
                    .checked_add(settlement.recipient_payout.0)
                    .unwrap_or_else(|| env::panic_str("treasury balance overflow"));
            }
        }
        self.accounts.flush();
        self.cars.flush();
        self.sessions.flush();
        self.space_sessions.flush();
        let released = before.saturating_sub(env::storage_usage());
        let released =
            u32::try_from(released).unwrap_or_else(|_| env::panic_str("released storage overflow"));
        let mut driver = self.registered_account(&session.driver);
        driver.used_storage_bytes = driver.used_storage_bytes.saturating_sub(released);
        self.accounts.insert(session.driver.clone(), driver);
        self.accounts.flush();
        let event = match reason {
            SettlementReason::Collect => "collected",
            SettlementReason::Expire => "expired",
            SettlementReason::Ticket => "ticketed",
        };
        self.emit(event, near_sdk::serde_json::json!({"session_id": session_id, "location_id": session.location_id, "slot": session.slot,
            "facility": if session.facility == Facility::Tower { "Tower" } else { "Curb" },
            "gross": settlement.gross.0.to_string(), "driver_payout": settlement.driver_payout.0.to_string(),
            "recipient_payout": settlement.recipient_payout.0.to_string(), "forfeited": settlement.forfeited.0.to_string()}));
        settlement
    }

    fn registered_account(&self, account_id: &AccountId) -> AccountState {
        self.accounts
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("player is not registered"))
    }

    fn owned_car(&self, car_id: u64, caller: &AccountId) -> Car {
        let car = self
            .cars
            .get(&car_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown car"));
        require!(&car.owner == caller, "car owner only");
        car
    }

    fn take_car_id(&mut self) -> u64 {
        let id = self.next_car_id;
        require!(id <= 9_000_000_000_000_000, "car ID limit reached");
        self.next_car_id = id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("car ID overflow"));
        id
    }

    fn plot_price(&self, corner: bool) -> u128 {
        let basis_points = if corner {
            self.config.corner_price_bps
        } else {
            10_000
        };
        self.config
            .plot_base_price_yocto
            .0
            .checked_mul(u128::from(basis_points))
            .unwrap_or_else(|| env::panic_str("plot price overflow"))
            / 10_000
    }

    fn now_seconds() -> u64 {
        env::block_timestamp_ms() / 1_000
    }

    fn space_key(facility: Facility, location_id: &str, slot: u8) -> String {
        let prefix = if facility == Facility::Tower {
            "t"
        } else {
            "c"
        };
        format!("{prefix}:{location_id}:{slot}")
    }

    fn storage_quote(&self, bytes: u32) -> u128 {
        env::storage_byte_cost()
            .as_yoctonear()
            .checked_mul(u128::from(bytes))
            .unwrap_or_else(|| env::panic_str("storage quote overflow"))
    }

    fn storage_delta(before: u64) -> u32 {
        let bytes = env::storage_usage()
            .checked_sub(before)
            .unwrap_or_else(|| env::panic_str("storage usage decreased unexpectedly"));
        u32::try_from(bytes).unwrap_or_else(|_| env::panic_str("storage delta overflow"))
    }

    fn refund_excess(&self, caller: AccountId, deposit: u128, quote: u128) {
        let excess = deposit
            .checked_sub(quote)
            .unwrap_or_else(|| env::panic_str("deposit below storage quote"));
        if excess > 0 {
            Promise::new(caller)
                .transfer(NearToken::from_yoctonear(excess))
                .detach();
        }
    }

    fn emit(&self, event: &str, data: near_sdk::serde_json::Value) {
        let payload = near_sdk::serde_json::json!({"standard": "near_estate", "version": "1.0.0", "event": event, "data": [data]});
        env::log_str(&format!("EVENT_JSON:{payload}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;
    use sha2::{Digest, Sha256};

    fn account(name: &str) -> AccountId {
        name.parse().expect("valid test account")
    }

    fn context(caller: &AccountId, deposit: u128, seconds: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(caller.clone())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .block_timestamp(
                seconds
                    .checked_mul(1_000_000_000)
                    .expect("test timestamp fits")
            )
            .build());
    }

    fn seeded_contract() -> Contract {
        let admin = account("admin.testnet");
        context(&admin, 0, 1_000);
        let mut contract = Contract::new(
            admin.clone(),
            account("moderator.testnet"),
            account("inspector.testnet"),
        );
        context(&admin, 1_000_000_000_000_000_000_000_000, 1_000);
        contract.seed_plot(PlotSeed {
            road_id: RoadId::Main,
            side: Side::North,
            index: 0,
            building_type: BuildingType::Retail,
            variant: 1,
        });
        contract
    }

    #[test]
    #[should_panic(expected = "contract account must initialize itself")]
    fn outsider_cannot_initialize_contract() {
        let admin = account("admin.testnet");
        context(&account("visitor.testnet"), 0, 1_000);
        Contract::new(
            admin,
            account("moderator.testnet"),
            account("inspector.testnet"),
        );
    }

    #[test]
    #[should_panic(expected = "admin must be the contract account")]
    fn self_initializer_cannot_assign_another_admin() {
        let admin = account("admin.testnet");
        context(&admin, 0, 1_000);
        Contract::new(
            account("visitor.testnet"),
            account("moderator.testnet"),
            account("inspector.testnet"),
        );
    }

    #[test]
    fn config_change_emits_versioned_event() {
        let mut contract = seeded_contract();
        context(&account("admin.testnet"), 0, 1_001);
        let mut config = contract.get_config();
        config.version = 2;
        contract.update_config(config);
        let logs = get_logs();
        let event = logs
            .last()
            .and_then(|line| line.strip_prefix("EVENT_JSON:"))
            .expect("config event log");
        let payload: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(event).expect("valid event JSON");
        assert_eq!(payload["standard"], "near_estate");
        assert_eq!(payload["version"], "1.0.0");
        assert_eq!(payload["event"], "config_updated");
        assert_eq!(payload["data"][0]["version"], 2);
        assert_eq!(payload["data"].as_array().map(Vec::len), Some(1));
    }

    fn register_at(contract: &mut Contract, player: &AccountId, seconds: u64) -> Car {
        context(player, contract.registration_quote().0, seconds);
        contract.register_player(CarBody::Hatchback, CarColor::Red)
    }

    fn seed_tower(contract: &mut Contract) {
        let admin = account("admin.testnet");
        context(&admin, 1_000_000_000_000_000_000_000_000, 1_000);
        contract.seed_npc_site(NPCSiteSeed {
            id: "npc-main-tower".to_string(),
            road_id: RoadId::Main,
            side: Side::South,
            frontage_index: 8,
            role: ServiceRole::ParkingTower,
            name: "Main Parking Tower".to_string(),
            capacity: 32,
        });
    }

    #[test]
    fn stored_value_layout_fixtures() {
        let mut contract = seeded_contract();
        seed_tower(&mut contract);
        let driver = account("driver.testnet");
        let car = register_at(&mut contract, &driver, 1_001);
        context(&driver, 0, 1_002);
        let session = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        let account_state = contract.accounts.get(&driver).expect("stored account");
        let stored_car = contract.cars.get(&car.id).expect("stored car");
        let plot = contract.plots.get("plot-main-n-0").expect("stored plot");
        let npc = contract
            .npc_sites
            .get("npc-main-tower")
            .expect("stored tower");
        let stored_session = contract.sessions.get(&session.id).expect("stored session");
        // These hashes guard the serialized state already deployed on testnet.
        // An intentional layout change must have a migration rehearsal first.
        let fixtures = [
            (
                "root",
                near_sdk::borsh::to_vec(&contract).expect("root bytes"),
                "d274e0f55f774f92970b9e38ee9fb8961883a34bcc66929b3a8991a325d7f782",
            ),
            (
                "config",
                near_sdk::borsh::to_vec(&contract.config).expect("config bytes"),
                "6bc2d05175c76201e89e859beed0457a18040dda1a73a487e43f0b7e8c0c5203",
            ),
            (
                "account",
                near_sdk::borsh::to_vec(account_state).expect("account bytes"),
                "dc7864026a9a3ed0dd9a7a15c76fd48aedb718c6f810586a1e0107898565b91e",
            ),
            (
                "car",
                near_sdk::borsh::to_vec(stored_car).expect("car bytes"),
                "89dcaeaaf139c71f6ac7a63275acd3e2b66452741a49b1ee686a51765dc968f4",
            ),
            (
                "plot",
                near_sdk::borsh::to_vec(plot).expect("plot bytes"),
                "3f0d75b80c16bee8b8839f1b03094344a3eca671ec0ef0058213f03494e3d392",
            ),
            (
                "npc",
                near_sdk::borsh::to_vec(npc).expect("npc bytes"),
                "66ba7040338cddbd60dc0a864f441f59d5e66b31f8909e9cd38e48d6cb088936",
            ),
            (
                "session",
                near_sdk::borsh::to_vec(stored_session).expect("session bytes"),
                "a68b63fa3b76b5f85c066a69e70c09b88e1c6e9faa55ce14d49ec962d59ee2c5",
            ),
        ];
        for (name, bytes, expected) in fixtures {
            assert_eq!(
                format!("{:x}", Sha256::digest(bytes)),
                expected,
                "{name} layout changed"
            );
        }
    }

    #[test]
    fn stored_enum_variant_tags() {
        use near_sdk::borsh::to_vec;

        // These enums are embedded in persisted map values. Reordering a
        // variant would reinterpret existing city data after a code upgrade.
        assert_eq!(
            to_vec(&[
                CarBody::Hatchback,
                CarBody::Sedan,
                CarBody::SportsCoupe,
                CarBody::SUV,
                CarBody::Pickup,
                CarBody::Microvan,
            ])
            .expect("car body tags"),
            [0, 1, 2, 3, 4, 5]
        );
        assert_eq!(
            to_vec(&[
                CarColor::Red,
                CarColor::Blue,
                CarColor::Yellow,
                CarColor::Green,
            ])
            .expect("car color tags"),
            [0, 1, 2, 3]
        );
        assert_eq!(
            to_vec(&[
                RoadId::Main,
                RoadId::Market,
                RoadId::River,
                RoadId::Central,
                RoadId::Harbor,
            ])
            .expect("road tags"),
            [0, 1, 2, 3, 4]
        );
        assert_eq!(
            to_vec(&[Side::North, Side::South]).expect("side tags"),
            [0, 1]
        );
        assert_eq!(
            to_vec(&[
                BuildingType::Retail,
                BuildingType::Cafe,
                BuildingType::Restaurant,
                BuildingType::Office,
                BuildingType::Homes,
            ])
            .expect("building type tags"),
            [0, 1, 2, 3, 4]
        );
        assert_eq!(to_vec(&ParkingRule::Free).expect("free rule"), [0]);
        let mut meter_bytes = vec![1];
        meter_bytes.extend_from_slice(&7u128.to_le_bytes());
        assert_eq!(
            to_vec(&ParkingRule::Meter {
                rate_per_hour: U128(7)
            })
            .expect("meter rule"),
            meter_bytes
        );
        assert_eq!(
            to_vec(&ParkingRule::ColorOnly {
                color: CarColor::Blue
            })
            .expect("color rule"),
            [2, 1]
        );
        assert_eq!(
            to_vec(&ParkingRule::NoParking).expect("no-parking rule"),
            [3]
        );
        assert_eq!(
            to_vec(&[MediaKind::Logo, MediaKind::Billboard]).expect("media kind tags"),
            [0, 1]
        );
        assert_eq!(
            to_vec(&[
                MediaDecisionStatus::Approved,
                MediaDecisionStatus::Rejected,
                MediaDecisionStatus::Revoked,
            ])
            .expect("media decision tags"),
            [0, 1, 2]
        );
        assert_eq!(
            to_vec(&[
                AppearanceStatus::Approved,
                AppearanceStatus::Rejected,
                AppearanceStatus::Revoked,
            ])
            .expect("appearance decision tags"),
            [0, 1, 2]
        );
        assert_eq!(
            to_vec(&[Facility::Curb, Facility::Tower]).expect("facility tags"),
            [0, 1]
        );
        assert_eq!(
            to_vec(&[
                ServiceRole::ParkingTower,
                ServiceRole::RepairGarage,
                ServiceRole::Cinema,
                ServiceRole::BurgerStop,
                ServiceRole::PracticeCourse,
            ])
            .expect("service role tags"),
            [0, 1, 2, 3, 4]
        );
    }

    fn owned_test_plot(contract: &mut Contract, owner: &AccountId) {
        register_at(contract, owner, 1_000);
        let quote = contract.plot_purchase_quote("plot-main-n-0".to_string()).0;
        context(owner, quote, 1_000);
        contract.buy_plot("plot-main-n-0".to_string());
    }

    fn credit_test_coins(contract: &mut Contract, owner: &AccountId, coins: u128) {
        let mut state = contract
            .get_account(owner.clone())
            .expect("owner registered");
        state.balance.0 = state
            .balance
            .0
            .checked_add(coins * 1_000_000)
            .expect("test credit fits");
        contract.accounts.insert(owner.clone(), state);
    }

    fn hash(character: char) -> String {
        character.to_string().repeat(64)
    }

    #[test]
    fn defaults_match_economy() {
        let admin: AccountId = "admin.testnet".parse().expect("valid test account");
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(admin.clone())
            .build());
        let contract = Contract::new(admin.clone(), admin.clone(), admin);
        assert_eq!(contract.get_config().base_rate_per_hour.0, 60_000_000);
        assert_eq!(contract.get_config().earn_cap_seconds, 1_800);
        assert_eq!(contract.get_config().tower_capacity, 32);
        assert_eq!(contract.get_config().plot_storage_bytes, 4_096);
        let json = near_sdk::serde_json::to_value(contract.get_config())
            .expect("config serializes for JSON views");
        assert!(json["plot_base_price_yocto"].is_string());
        assert!(json["base_rate_per_hour"].is_string());
    }

    #[test]
    fn emergency_repair_restores_configured_parking_durability() {
        let mut contract = seeded_contract();
        let admin = account("admin.testnet");
        context(&admin, 0, 1_001);
        let mut config = contract.get_config();
        config.version = 2;
        config.park_durability_cost = 4;
        contract.update_config(config);

        let player = account("driver.testnet");
        let mut car = register_at(&mut contract, &player, 1_002);
        car.durability = 3;
        contract.cars.insert(car.id, car.clone());
        let mut state = contract
            .get_account(player.clone())
            .expect("registered player");
        state.balance.0 = 0;
        contract.accounts.insert(player.clone(), state);

        context(&player, 0, 1_003);
        let repaired = contract.emergency_repair();
        assert_eq!(repaired.durability, 4);
        let logs = get_logs();
        let event = logs
            .last()
            .and_then(|line| line.strip_prefix("EVENT_JSON:"))
            .expect("repair event");
        let payload: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_str(event).expect("valid event JSON");
        assert_eq!(payload["data"][0]["points"], 1);

        let session = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        assert_eq!(session.car_id, car.id);
        assert_eq!(contract.get_car(car.id).expect("parked car").durability, 0);
    }

    #[test]
    #[should_panic(expected = "can afford a repair to parking durability")]
    fn emergency_repair_rejects_player_who_can_afford_to_park() {
        let mut contract = seeded_contract();
        let player = account("driver.testnet");
        let mut car = register_at(&mut contract, &player, 1_002);
        car.durability = 1;
        contract.cars.insert(car.id, car);
        let mut state = contract
            .get_account(player.clone())
            .expect("registered player");
        state.balance.0 = contract.get_config().repair_cost_per_point.0;
        contract.accounts.insert(player.clone(), state);

        context(&player, 0, 1_003);
        contract.emergency_repair();
    }

    #[test]
    fn plot_quote_separates_corner_price_and_storage_reserve() {
        let contract = seeded_contract();
        let quote = contract.plot_purchase_breakdown("plot-main-n-0".to_string());
        assert_eq!(quote.price_yocto.0, 2_000_000_000_000_000_000_000_000);
        assert!(quote.storage_reserve_yocto.0 > 0);
        assert_eq!(
            quote.total_yocto.0,
            quote.price_yocto.0 + quote.storage_reserve_yocto.0
        );
        assert_eq!(
            contract.plot_purchase_quote("plot-main-n-0".to_string()).0,
            quote.total_yocto.0
        );
        let json = near_sdk::serde_json::to_value(quote).expect("quote serializes");
        assert!(json["price_yocto"].is_string());
        assert!(json["storage_reserve_yocto"].is_string());
    }

    #[test]
    #[should_panic(expected = "max cars out of bounds")]
    fn rejects_unbounded_config_update() {
        let admin: AccountId = "admin.testnet".parse().expect("valid test account");
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(admin.clone())
            .build());
        let mut contract = Contract::new(admin.clone(), admin.clone(), admin);
        let mut config = contract.get_config();
        config.version = 2;
        config.max_cars = 4;
        contract.update_config(config);
    }

    #[test]
    #[should_panic(expected = "admin only")]
    fn only_admin_can_pause_admission() {
        let admin: AccountId = "admin.testnet".parse().expect("valid test account");
        let visitor: AccountId = "visitor.testnet".parse().expect("valid test account");
        context(&admin, 0, 1_000);
        let mut contract = Contract::new(admin.clone(), admin.clone(), admin);
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(visitor)
            .build());
        contract.set_paused(true);
    }

    #[test]
    fn pause_blocks_new_parking_but_allows_existing_settlement() {
        let mut contract = seeded_contract();
        let driver = account("driver.testnet");
        let admin = account("admin.testnet");
        let car = register_at(&mut contract, &driver, 1_000);
        context(&driver, 0, 1_000);
        let session = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        context(&admin, 0, 1_001);
        contract.set_paused(true);
        context(&driver, 0, 1_300);
        assert_eq!(contract.collect(session.id).gross.0, 5_000_000);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            contract.park(car.id, "plot-main-n-0".to_string(), 0)
        }))
        .is_err());
        assert!(contract
            .get_space_session("plot-main-n-0".to_string(), 0)
            .is_none());
    }

    #[test]
    fn pause_freezes_plot_and_moderation_changes() {
        use std::panic::{catch_unwind, AssertUnwindSafe};

        let mut contract = seeded_contract();
        let admin = account("admin.testnet");
        let owner = account("owner.testnet");
        let moderator = account("moderator.testnet");
        context(&admin, 1_000_000_000_000_000_000_000_000, 1_000);
        contract.seed_plot(PlotSeed {
            road_id: RoadId::Main,
            side: Side::North,
            index: 1,
            building_type: BuildingType::Retail,
            variant: 1,
        });
        register_at(&mut contract, &owner, 1_000);
        let first_id = "plot-main-n-0".to_string();
        let second_id = "plot-main-n-1".to_string();
        context(
            &owner,
            contract.plot_purchase_quote(first_id.clone()).0,
            1_001,
        );
        contract.buy_plot(first_id.clone());
        let plot = contract
            .get_plot(first_id.clone())
            .expect("owned plot")
            .plot;
        context(&owner, 0, 1_002);
        let media = contract.propose_media(
            first_id.clone(),
            MediaKind::Logo,
            plot.logo.revision,
            plot.building.layout_revision,
            MediaIdentity {
                asset_hash: "a".repeat(64),
                link: None,
            },
        );
        let appearance = contract.propose_appearance(
            first_id.clone(),
            plot.building.appearance_revision,
            "b".repeat(64),
        );
        let before = contract
            .get_plot(first_id.clone())
            .expect("owned plot")
            .plot;

        context(&admin, 0, 1_003);
        contract.set_paused(true);
        context(
            &owner,
            contract.plot_purchase_quote(second_id.clone()).0,
            1_004,
        );
        assert!(catch_unwind(AssertUnwindSafe(|| contract.buy_plot(second_id.clone()))).is_err());
        context(&owner, 0, 1_004);
        assert!(catch_unwind(AssertUnwindSafe(
            || contract.set_rule(first_id.clone(), ParkingRule::NoParking,)
        ))
        .is_err());
        assert!(catch_unwind(AssertUnwindSafe(|| contract.choose_preset(
            first_id.clone(),
            2,
            "#73D9A6".to_string(),
            "Freeze Test".to_string(),
        )))
        .is_err());
        assert!(catch_unwind(AssertUnwindSafe(|| contract.remove_media(
            first_id.clone(),
            MediaKind::Logo,
            media.revision,
        )))
        .is_err());
        context(&moderator, 0, 1_004);
        assert!(catch_unwind(AssertUnwindSafe(|| contract.approve_media(
            first_id.clone(),
            MediaKind::Logo,
            media.clone(),
        )))
        .is_err());
        assert!(catch_unwind(AssertUnwindSafe(
            || contract.approve_appearance(first_id.clone(), appearance.clone(),)
        ))
        .is_err());
        context(&admin, 1_000_000_000_000_000_000_000_000, 1_004);
        assert!(
            catch_unwind(AssertUnwindSafe(|| contract.seed_plot(PlotSeed {
                road_id: RoadId::Main,
                side: Side::North,
                index: 2,
                building_type: BuildingType::Retail,
                variant: 1,
            })))
            .is_err()
        );
        let mut next_config = contract.get_config();
        next_config.version += 1;
        assert!(catch_unwind(AssertUnwindSafe(|| contract.update_config(next_config))).is_err());
        let after = contract.get_plot(first_id).expect("owned plot").plot;
        assert_eq!(contract.plot_count(), 2);
        assert!(contract
            .get_plot(second_id)
            .expect("unowned plot")
            .plot
            .owner
            .is_none());
        assert_eq!(
            after.building.appearance_revision,
            before.building.appearance_revision
        );
        assert_eq!(after.logo.revision, before.logo.revision);
        assert_eq!(after.pending_rule.is_some(), before.pending_rule.is_some());
    }

    #[test]
    fn registration_grants_one_starter_and_accounts_for_storage() {
        let admin: AccountId = "admin.testnet".parse().expect("valid admin account");
        let player: AccountId = "driver.testnet".parse().expect("valid player account");
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(admin.clone())
            .build());
        let mut contract = Contract::new(admin.clone(), admin.clone(), admin);
        let quote = contract.registration_quote().0;
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(player.clone())
            .attached_deposit(NearToken::from_yoctonear(quote))
            .build());
        let car = contract.register_player(CarBody::Hatchback, CarColor::Red);
        assert_eq!(car.id, 1);
        assert_eq!(car.durability, 100);
        let account = contract
            .get_account(player.clone())
            .expect("registered account");
        assert_eq!(account.balance.0, 100_000_000);
        assert_eq!(account.car_ids, vec![car.id]);
        assert!(account.used_storage_bytes > 0);
        assert!(account.used_storage_bytes <= account.reserved_storage_bytes);
        assert_eq!(contract.get_cars(player).len(), 1);
    }

    #[test]
    fn street_view_identifies_each_parked_car_without_extra_reads() {
        let mut contract = seeded_contract();
        let first_driver = account("first.testnet");
        let second_driver = account("second.testnet");
        context(&first_driver, contract.registration_quote().0, 1_001);
        let sports = contract.register_player(CarBody::SportsCoupe, CarColor::Green);
        context(&second_driver, contract.registration_quote().0, 1_002);
        let pickup = contract.register_player(CarBody::Pickup, CarColor::Yellow);

        context(&first_driver, 0, 1_003);
        let first_session = contract.park(sports.id, "plot-main-n-0".to_string(), 0);
        context(&second_driver, 0, 1_004);
        contract.park(pickup.id, "plot-main-n-0".to_string(), 1);

        let street = contract.get_street_side(RoadId::Main, Side::North);
        let plot = &street.plots[0];
        assert_eq!(
            plot.car_appearances[0].as_ref().map(|car| car.id),
            Some(sports.id)
        );
        assert_eq!(
            plot.car_appearances[1].as_ref().map(|car| car.id),
            Some(pickup.id)
        );
        let json = near_sdk::serde_json::to_value(plot).expect("street plot serializes");
        assert_eq!(json["car_appearances"][0]["body"], "SportsCoupe");
        assert_eq!(json["car_appearances"][0]["color"], "Green");
        assert_eq!(json["car_appearances"][1]["body"], "Pickup");
        assert_eq!(json["car_appearances"][1]["color"], "Yellow");

        context(&first_driver, 0, 1_010);
        contract.collect(first_session.id);
        let after = contract.get_street_side(RoadId::Main, Side::North);
        assert!(after.plots[0].car_appearances[0].is_none());
        assert_eq!(
            after.plots[0].car_appearances[1].as_ref().map(|car| car.id),
            Some(pickup.id)
        );
    }

    #[test]
    fn registration_purchase_and_cosmetic_events_include_exact_coin_amounts() {
        let admin = account("admin.testnet");
        let player = account("driver.testnet");
        context(&admin, 0, 1_000);
        let mut contract = Contract::new(
            admin.clone(),
            account("moderator.testnet"),
            account("inspector.testnet"),
        );
        let mut config = contract.get_config();
        config.version = 2;
        config.buy_car_cost = U128(50_000_000);
        contract.update_config(config);
        context(&player, contract.registration_quote().0, 1_001);
        contract.register_player(CarBody::Hatchback, CarColor::Red);
        let registration_logs = get_logs();
        let events: Vec<near_sdk::serde_json::Value> = registration_logs
            .iter()
            .filter_map(|line| line.strip_prefix("EVENT_JSON:"))
            .map(|json| near_sdk::serde_json::from_str(json).expect("event JSON"))
            .collect();
        assert!(events.iter().any(|event| {
            event["event"] == "player_registered" && event["data"][0]["grant"] == "100000000"
        }));
        assert!(events.iter().any(|event| {
            event["event"] == "car_minted"
                && event["data"][0]["source"] == "starter"
                && event["data"][0]["cost"] == "0"
        }));
        context(&player, 0, 1_002);
        contract.buy_car(CarBody::Sedan, CarColor::Blue);
        let bought: near_sdk::serde_json::Value = get_logs()
            .last()
            .and_then(|line| line.strip_prefix("EVENT_JSON:"))
            .map(|json| near_sdk::serde_json::from_str(json).expect("event JSON"))
            .expect("car purchase event");
        assert_eq!(bought["data"][0]["source"], "purchase");
        assert_eq!(bought["data"][0]["cost"], "50000000");
        context(&player, 0, 1_003);
        contract.buy_cosmetic();
        let cosmetic: near_sdk::serde_json::Value = get_logs()
            .last()
            .and_then(|line| line.strip_prefix("EVENT_JSON:"))
            .map(|json| near_sdk::serde_json::from_str(json).expect("event JSON"))
            .expect("cosmetic event");
        assert_eq!(cosmetic["data"][0]["cost"], "30000000");
    }

    #[test]
    #[should_panic(expected = "three-car limit reached")]
    fn enforces_three_car_limit() {
        let admin: AccountId = "admin.testnet".parse().expect("valid admin account");
        let player: AccountId = "driver.testnet".parse().expect("valid player account");
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(admin.clone())
            .build());
        let mut contract = Contract::new(admin.clone(), admin.clone(), admin);
        let mut config = contract.get_config();
        config.version = 2;
        config.buy_car_cost = U128(0);
        contract.update_config(config);
        let quote = contract.registration_quote().0;
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(player)
            .attached_deposit(NearToken::from_yoctonear(quote))
            .build());
        contract.register_player(CarBody::Hatchback, CarColor::Red);
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id("driver.testnet".parse().expect("valid player account"))
            .build());
        contract.buy_car(CarBody::Sedan, CarColor::Blue);
        contract.buy_car(CarBody::Pickup, CarColor::Green);
        contract.buy_car(CarBody::Microvan, CarColor::Yellow);
    }

    #[test]
    fn repair_uses_checked_coin_math_and_restores_only_requested_points() {
        let admin: AccountId = "admin.testnet".parse().expect("valid admin account");
        let player: AccountId = "driver.testnet".parse().expect("valid player account");
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(admin.clone())
            .build());
        let mut contract = Contract::new(admin.clone(), admin.clone(), admin);
        let quote = contract.registration_quote().0;
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(player.clone())
            .attached_deposit(NearToken::from_yoctonear(quote))
            .build());
        let mut car = contract.register_player(CarBody::Hatchback, CarColor::Red);
        car.durability = 97;
        contract.cars.insert(car.id, car.clone());
        let repaired = contract.repair(car.id, 2);
        assert_eq!(repaired.durability, 99);
        assert_eq!(
            contract
                .get_account(player)
                .expect("player exists")
                .balance
                .0,
            98_000_000
        );
    }

    #[test]
    #[should_panic(expected = "insufficient registration storage deposit")]
    fn registration_requires_prepaid_storage() {
        let admin: AccountId = "admin.testnet".parse().expect("valid admin account");
        let player: AccountId = "driver.testnet".parse().expect("valid player account");
        context(&admin, 0, 1_000);
        let mut contract = Contract::new(admin.clone(), admin.clone(), admin);
        testing_env!(VMContextBuilder::new()
            .current_account_id(account("admin.testnet"))
            .predecessor_account_id(player)
            .build());
        contract.register_player(CarBody::Hatchback, CarColor::Red);
    }

    #[test]
    fn legal_park_collect_and_one_time_settlement() {
        let mut contract = seeded_contract();
        let driver = account("driver.testnet");
        let car = register_at(&mut contract, &driver, 1_000);
        context(&driver, 0, 1_000);
        let session = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        assert!(session.legal);
        assert_eq!(contract.get_car(car.id).expect("car exists").durability, 98);
        context(&driver, 0, 1_300);
        let settlement = contract.collect(session.id);
        assert_eq!(settlement.gross.0, 5_000_000);
        assert_eq!(settlement.driver_payout.0, 5_000_000);
        assert_eq!(
            contract
                .get_account(driver)
                .expect("player exists")
                .balance
                .0,
            105_000_000
        );
        assert!(contract
            .get_space_session("plot-main-n-0".to_string(), 0)
            .is_none());
        assert!(contract.get_session(session.id).is_none());
    }

    #[test]
    fn illegal_earnings_stop_at_thirty_minute_cap() {
        let mut contract = seeded_contract();
        let owner = account("owner.testnet");
        let driver = account("driver.testnet");
        owned_test_plot(&mut contract, &owner);
        let car = register_at(&mut contract, &driver, 1_000);
        context(&owner, 0, 1_000);
        contract.set_rule("plot-main-n-0".to_string(), ParkingRule::NoParking);
        context(&driver, 0, 1_300);
        let session = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        assert!(!session.legal);
        context(&driver, 0, 3_500);
        let settled = contract.settle_expired(session.id);
        assert_eq!(settled.gross.0, 45_000_000);
        assert_eq!(settled.driver_payout.0, 45_000_000);
        assert_eq!(
            contract
                .get_account(driver)
                .expect("driver exists")
                .balance
                .0,
            145_000_000
        );
    }

    #[test]
    fn repeated_parks_reuse_prepaid_session_storage() {
        let mut contract = seeded_contract();
        let driver = account("driver.testnet");
        let car = register_at(&mut contract, &driver, 1_000);
        let initial = contract
            .get_account(driver.clone())
            .expect("player exists")
            .used_storage_bytes;
        for index in 0..20u64 {
            let start = 1_000 + index * 2;
            context(&driver, 0, start);
            let session = contract.park(car.id, "plot-main-n-0".to_string(), 0);
            context(&driver, 0, start + 1);
            contract.collect(session.id);
        }
        assert_eq!(
            contract
                .get_account(driver)
                .expect("player exists")
                .used_storage_bytes,
            initial
        );
    }

    #[test]
    fn meter_and_later_rule_change_preserve_parked_terms() {
        let mut contract = seeded_contract();
        let driver = account("driver.testnet");
        let owner = account("owner.testnet");
        let car = register_at(&mut contract, &driver, 1_000);
        register_at(&mut contract, &owner, 1_000);
        let quote = contract.plot_purchase_quote("plot-main-n-0".to_string()).0;
        context(&owner, quote, 1_000);
        contract.buy_plot("plot-main-n-0".to_string());
        context(&owner, 0, 1_000);
        let pending = contract.set_rule(
            "plot-main-n-0".to_string(),
            ParkingRule::Meter {
                rate_per_hour: U128(30_000_000),
            },
        );
        assert!(matches!(pending.effective_rule, ParkingRule::Free));
        context(&driver, 0, 1_300);
        let session = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        assert!(session.legal);
        context(&owner, 0, 1_400);
        contract.set_rule("plot-main-n-0".to_string(), ParkingRule::NoParking);
        context(&driver, 0, 3_100);
        let settlement = contract.collect(session.id);
        assert_eq!(settlement.gross.0, 30_000_000);
        assert_eq!(settlement.recipient_payout.0, 15_000_000);
        assert_eq!(settlement.driver_payout.0, 15_000_000);
        assert_eq!(
            contract
                .get_account(driver)
                .expect("driver exists")
                .balance
                .0,
            115_000_000
        );
        assert_eq!(
            contract.get_account(owner).expect("owner exists").balance.0,
            115_000_000
        );
    }

    #[test]
    fn rule_deadlines_and_config_updates_keep_each_parking_session_terms() {
        let mut contract = seeded_contract();
        let owner = account("owner.testnet");
        let driver = account("driver.testnet");
        owned_test_plot(&mut contract, &owner);
        let car = register_at(&mut contract, &driver, 1_000);

        context(&owner, 0, 1_000);
        contract.set_rule(
            "plot-main-n-0".to_string(),
            ParkingRule::Meter {
                rate_per_hour: U128(30_000_000),
            },
        );
        context(&driver, 0, 1_299);
        let before_deadline = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        assert!(before_deadline.legal);
        assert_eq!(before_deadline.terms.meter_rate_per_hour.0, 0);

        context(&driver, 0, 1_300);
        let first_payout = contract.collect(before_deadline.id);
        assert_eq!(first_payout.recipient_payout.0, 0);
        context(&owner, 0, 1_300);
        let replaced = contract.set_rule("plot-main-n-0".to_string(), ParkingRule::NoParking);
        assert!(matches!(replaced.effective_rule, ParkingRule::Meter { .. }));
        assert_eq!(
            replaced
                .plot
                .pending_rule
                .as_ref()
                .map(|rule| rule.effective_at),
            Some(1_600)
        );

        context(&driver, 0, 1_300);
        let at_deadline = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        assert!(at_deadline.legal);
        assert_eq!(at_deadline.terms.meter_rate_per_hour.0, 30_000_000);
        assert_eq!(at_deadline.terms.base_rate_per_hour.0, 60_000_000);
        assert_eq!(at_deadline.terms.earn_cap_seconds, 1_800);

        context(&account("admin.testnet"), 0, 1_301);
        let mut config = contract.get_config();
        config.version = 2;
        config.base_rate_per_hour = U128(120_000_000);
        config.earn_cap_seconds = 600;
        contract.update_config(config);
        context(&driver, 0, 1_599);
        assert!(matches!(
            contract
                .get_plot("plot-main-n-0".to_string())
                .expect("plot exists")
                .effective_rule,
            ParkingRule::Meter { .. }
        ));
        context(&driver, 0, 1_600);
        assert!(matches!(
            contract
                .get_plot("plot-main-n-0".to_string())
                .expect("plot exists")
                .effective_rule,
            ParkingRule::NoParking
        ));
        let payout = contract.collect(at_deadline.id);
        assert_eq!(payout.gross.0, 5_000_000);
        assert_eq!(payout.recipient_payout.0, 2_500_000);
        assert_eq!(payout.driver_payout.0, 2_500_000);

        let after_deadline = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        assert!(!after_deadline.legal);
        assert_eq!(after_deadline.terms.base_rate_per_hour.0, 120_000_000);
        assert_eq!(after_deadline.terms.earn_cap_seconds, 600);
        assert_eq!(after_deadline.terms.config_version, 2);
    }

    #[test]
    fn expired_space_reuse_pays_old_driver_once() {
        let mut contract = seeded_contract();
        let first = account("first.testnet");
        let second = account("second.testnet");
        let first_car = register_at(&mut contract, &first, 1_000);
        let second_car = register_at(&mut contract, &second, 1_000);
        context(&first, 0, 1_000);
        let old = contract.park(first_car.id, "plot-main-n-0".to_string(), 0);
        context(&second, 0, 2_920);
        let fresh = contract.park(second_car.id, "plot-main-n-0".to_string(), 0);
        assert_ne!(old.id, fresh.id);
        assert!(contract.get_session(old.id).is_none());
        assert_eq!(
            contract.get_account(first).expect("first exists").balance.0,
            130_000_000
        );
        assert_eq!(
            contract
                .get_car(first_car.id)
                .expect("car exists")
                .parked_session_id,
            None
        );
    }

    #[test]
    fn owner_ticket_forfeits_driver_earnings_and_obeys_cooldown() {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        let mut contract = seeded_contract();
        let driver = account("driver.testnet");
        let owner = account("owner.testnet");
        let car = register_at(&mut contract, &driver, 1_000);
        register_at(&mut contract, &owner, 1_000);
        let quote = contract.plot_purchase_quote("plot-main-n-0".to_string()).0;
        context(&owner, quote, 1_000);
        contract.buy_plot("plot-main-n-0".to_string());
        context(&owner, 0, 1_000);
        contract.set_rule("plot-main-n-0".to_string(), ParkingRule::NoParking);
        context(&driver, 0, 1_300);
        let first = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        assert!(!first.legal);
        context(&owner, 0, 1_600);
        let settlement = contract.ticket("plot-main-n-0".to_string(), 0, first.id);
        assert_eq!(settlement.gross.0, 7_500_000);
        assert_eq!(settlement.recipient_payout.0, 5_250_000);
        assert_eq!(settlement.forfeited.0, 2_250_000);
        assert_eq!(
            contract
                .get_account(driver.clone())
                .expect("driver exists")
                .balance
                .0,
            100_000_000
        );
        assert_eq!(
            contract
                .get_account(owner.clone())
                .expect("owner exists")
                .balance
                .0,
            105_250_000
        );
        assert!(catch_unwind(AssertUnwindSafe(|| contract.ticket(
            "plot-main-n-0".to_string(),
            0,
            first.id
        )))
        .is_err());
        context(&driver, 0, 1_601);
        let second = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        context(&owner, 0, 1_601);
        assert!(catch_unwind(AssertUnwindSafe(|| contract.ticket(
            "plot-main-n-0".to_string(),
            0,
            second.id
        )))
        .is_err());
        context(&owner, 0, 1_900);
        assert!(
            contract
                .ticket("plot-main-n-0".to_string(), 0, second.id)
                .recipient_payout
                .0
                > 0
        );
    }

    #[test]
    fn inspector_draw_is_separate_for_sessions_in_one_block() {
        let seed = [7u8; 32];
        context(&account("inspector.testnet"), 0, 1_600);
        let first = Contract::inspection_roll(&seed, 17);
        let second = Contract::inspection_roll(&seed, 18);
        assert_eq!(first, Contract::inspection_roll(&seed, 17));
        assert_ne!(first, second);
        assert!(first < 10_000 && second < 10_000);
    }

    #[test]
    fn inspector_success_pays_treasury_only_after_age_gate() {
        let mut contract = seeded_contract();
        let admin = account("admin.testnet");
        let owner = account("owner.testnet");
        let driver = account("driver.testnet");
        let inspector = account("inspector.testnet");
        context(&admin, 0, 1_000);
        let mut config = contract.get_config();
        config.version = 2;
        config.inspector_chance_bps = 10_000;
        contract.update_config(config);
        let car = register_at(&mut contract, &driver, 1_000);
        register_at(&mut contract, &owner, 1_000);
        let quote = contract.plot_purchase_quote("plot-main-n-0".to_string()).0;
        context(&owner, quote, 1_000);
        contract.buy_plot("plot-main-n-0".to_string());
        context(&owner, 0, 1_000);
        contract.set_rule("plot-main-n-0".to_string(), ParkingRule::NoParking);
        context(&driver, 0, 1_300);
        let session = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        context(&inspector, 0, 1_599);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.inspect(
                "plot-main-n-0".to_string(),
                0,
                session.id
            )))
            .is_err()
        );
        context(&inspector, 0, 1_600);
        let result = contract
            .inspect("plot-main-n-0".to_string(), 0, session.id)
            .expect("100% inspection succeeds");
        assert_eq!(result.recipient_payout.0, 5_250_000);
        assert_eq!(contract.get_treasury_coins().0, 5_250_000);
        assert_eq!(
            contract.get_account(owner).expect("owner exists").balance.0,
            100_000_000
        );
        assert_eq!(
            contract
                .get_account(driver)
                .expect("driver exists")
                .balance
                .0,
            100_000_000
        );
    }

    #[test]
    fn failed_inspection_consumes_the_session_attempt() {
        let mut contract = seeded_contract();
        let admin = account("admin.testnet");
        let owner = account("owner.testnet");
        let driver = account("driver.testnet");
        let inspector = account("inspector.testnet");
        context(&admin, 0, 1_000);
        let mut config = contract.get_config();
        config.version = 2;
        config.inspector_chance_bps = 0;
        contract.update_config(config);
        let car = register_at(&mut contract, &driver, 1_000);
        register_at(&mut contract, &owner, 1_000);
        let quote = contract.plot_purchase_quote("plot-main-n-0".to_string()).0;
        context(&owner, quote, 1_000);
        contract.buy_plot("plot-main-n-0".to_string());
        context(&owner, 0, 1_000);
        contract.set_rule("plot-main-n-0".to_string(), ParkingRule::NoParking);
        context(&driver, 0, 1_300);
        let session = contract.park(car.id, "plot-main-n-0".to_string(), 0);
        context(&inspector, 0, 1_600);
        assert!(contract
            .inspect("plot-main-n-0".to_string(), 0, session.id)
            .is_none());
        assert!(
            contract
                .get_session(session.id)
                .expect("session remains")
                .inspector_attempted
        );
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.inspect(
                "plot-main-n-0".to_string(),
                0,
                session.id
            )))
            .is_err()
        );
    }

    #[test]
    fn tower_earns_half_rate_and_is_never_ticketable() {
        let mut contract = seeded_contract();
        seed_tower(&mut contract);
        assert_eq!(
            contract.get_tower_open_space("npc-main-tower".to_string()),
            Some(0)
        );
        let driver = account("driver.testnet");
        let car = register_at(&mut contract, &driver, 1_000);
        context(&driver, 0, 1_000);
        let session = contract.park_tower(car.id, "npc-main-tower".to_string(), 0);
        assert!(session.legal);
        assert_eq!(
            contract.get_tower_availability("npc-main-tower".to_string()),
            31
        );
        assert_eq!(
            contract.get_tower_open_space("npc-main-tower".to_string()),
            Some(1)
        );
        assert!(contract
            .get_tower_space_session("npc-main-tower".to_string(), 0)
            .is_some());
        let inspector = account("inspector.testnet");
        context(&inspector, 0, 1_300);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.inspect(
                "npc-main-tower".to_string(),
                0,
                session.id
            )))
            .is_err()
        );
        context(&driver, 0, 2_800);
        let settlement = contract.collect(session.id);
        assert_eq!(settlement.gross.0, 15_000_000);
        assert_eq!(settlement.driver_payout.0, 15_000_000);
        assert_eq!(
            contract.get_tower_availability("npc-main-tower".to_string()),
            32
        );
    }

    #[test]
    fn tower_has_exactly_thirty_two_physical_spaces() {
        let mut contract = seeded_contract();
        seed_tower(&mut contract);
        assert_eq!(
            contract.get_tower_floor_availability("npc-main-tower".to_string()),
            vec![8, 8, 8, 8]
        );
        assert!(contract
            .get_tower_floor_sessions("npc-main-tower".to_string(), 2)
            .iter()
            .all(Option::is_none));
        assert_eq!(
            contract.get_tower_open_space_on_floor("npc-main-tower".to_string(), 2),
            Some(16)
        );
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || contract.get_tower_open_space_on_floor("npc-main-tower".to_string(), 4)
        ))
        .is_err());
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || contract.get_tower_floor_sessions("npc-main-tower".to_string(), 4)
        ))
        .is_err());
        let mut first_car = 0;
        for space in 0..32u8 {
            let driver = account(&format!("driver{space}.testnet"));
            let car = register_at(&mut contract, &driver, 1_000);
            if space == 0 {
                first_car = car.id;
            }
            context(&driver, 0, 1_000);
            contract.park_tower(car.id, "npc-main-tower".to_string(), space);
            if space == 7 {
                let floor = contract.get_tower_floor_sessions("npc-main-tower".to_string(), 0);
                assert_eq!(floor.len(), 8);
                assert_eq!(
                    floor[0].as_ref().map(|session| session.car_id),
                    Some(first_car)
                );
                assert!(floor.iter().all(Option::is_some));
                assert_eq!(
                    contract.get_tower_floor_availability("npc-main-tower".to_string()),
                    vec![0, 8, 8, 8]
                );
                assert_eq!(
                    contract.get_tower_open_space_on_floor("npc-main-tower".to_string(), 0),
                    None
                );
                assert_eq!(
                    contract.get_tower_open_space_on_floor("npc-main-tower".to_string(), 1),
                    Some(8)
                );
            }
        }
        assert_eq!(
            contract.get_tower_availability("npc-main-tower".to_string()),
            0
        );
        assert_eq!(
            contract.get_tower_open_space("npc-main-tower".to_string()),
            None
        );
        assert_eq!(
            contract.get_tower_floor_availability("npc-main-tower".to_string()),
            vec![0, 0, 0, 0]
        );
        let extra = account("extra.testnet");
        let extra_car = register_at(&mut contract, &extra, 1_000);
        context(&extra, 0, 1_000);
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| contract.park_tower(
                extra_car.id,
                "npc-main-tower".to_string(),
                0
            )))
            .is_err()
        );
        context(&extra, 0, 2_920);
        assert_eq!(
            contract.get_tower_floor_availability("npc-main-tower".to_string()),
            vec![8, 8, 8, 8]
        );
        assert_eq!(
            contract.get_tower_open_space("npc-main-tower".to_string()),
            Some(0)
        );
        contract.park_tower(extra_car.id, "npc-main-tower".to_string(), 0);
        assert_eq!(
            contract.get_tower_availability("npc-main-tower".to_string()),
            31
        );
        assert_eq!(
            contract
                .get_account(account("driver0.testnet"))
                .expect("first driver exists")
                .balance
                .0,
            115_000_000
        );
        assert!(contract
            .get_car(first_car)
            .expect("car exists")
            .parked_session_id
            .is_none());
    }

    #[test]
    fn owner_can_choose_preset_type_and_all_four_paid_levels() {
        let mut contract = seeded_contract();
        let owner = account("owner.testnet");
        owned_test_plot(&mut contract, &owner);
        context(&owner, 0, 1_100);
        let plot = contract.choose_preset(
            "plot-main-n-0".to_string(),
            2,
            "#73D9A6".to_string(),
            "Greenhouse Cafe".to_string(),
        );
        assert_eq!(plot.building.variant, 2);
        assert_eq!(plot.building.name, "Greenhouse Cafe");
        assert_eq!(plot.building.appearance_revision, 2);
        let plot =
            contract.change_building_type("plot-main-n-0".to_string(), BuildingType::Cafe, 1);
        assert!(plot.building.building_type == BuildingType::Cafe);
        assert_eq!(plot.building.level, 1);
        assert_eq!(
            contract
                .get_account(owner.clone())
                .expect("owner exists")
                .balance
                .0,
            0
        );
        credit_test_coins(&mut contract, &owner, 2_300);
        for expected_level in 2..=4 {
            let plot = contract.upgrade_building("plot-main-n-0".to_string());
            assert_eq!(plot.building.level, expected_level);
            assert_eq!(plot.building.facade_exemption_level, Some(expected_level));
        }
        assert_eq!(
            contract
                .get_account(owner.clone())
                .expect("owner exists")
                .balance
                .0,
            0
        );
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || contract.upgrade_building("plot-main-n-0".to_string())
        ))
        .is_err());
    }

    #[test]
    fn exact_appearance_approval_cooldown_exemption_and_revocation() {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        let mut contract = seeded_contract();
        let owner = account("owner.testnet");
        let moderator = account("moderator.testnet");
        owned_test_plot(&mut contract, &owner);
        context(&owner, 0, 1_100);
        let first = contract.propose_appearance("plot-main-n-0".to_string(), 1, hash('a'));
        context(&moderator, 0, 1_200);
        let mut mismatched = first.clone();
        mismatched.manifest_hash = hash('b');
        assert!(catch_unwind(AssertUnwindSafe(
            || contract.approve_appearance("plot-main-n-0".to_string(), mismatched)
        ))
        .is_err());
        let plot = contract.approve_appearance("plot-main-n-0".to_string(), first.clone());
        assert_eq!(plot.building.approved_manifest_hash, Some(hash('a')));
        assert_eq!(plot.building.level, 1, "art approval cannot grant a level");
        context(&owner, 0, 1_300);
        let second =
            contract.propose_appearance("plot-main-n-0".to_string(), first.revision, hash('b'));
        context(&moderator, 0, 1_400);
        assert!(catch_unwind(AssertUnwindSafe(
            || contract.approve_appearance("plot-main-n-0".to_string(), second.clone())
        ))
        .is_err());
        context(&owner, 0, 1_500);
        credit_test_coins(&mut contract, &owner, 100);
        let upgraded = contract.upgrade_building("plot-main-n-0".to_string());
        assert_eq!(upgraded.building.level, 2);
        assert!(upgraded.building.pending_appearance.is_none());
        assert!(upgraded.building.approved_manifest_hash.is_none());
        context(&moderator, 0, 1_600);
        assert!(catch_unwind(AssertUnwindSafe(
            || contract.approve_appearance("plot-main-n-0".to_string(), second)
        ))
        .is_err());
        context(&owner, 0, 1_700);
        let current_revision = contract
            .get_plot("plot-main-n-0".to_string())
            .expect("plot exists")
            .plot
            .building
            .appearance_revision;
        let third =
            contract.propose_appearance("plot-main-n-0".to_string(), current_revision, hash('c'));
        context(&moderator, 0, 1_800);
        let approved = contract.approve_appearance("plot-main-n-0".to_string(), third.clone());
        assert_eq!(approved.building.approved_manifest_hash, Some(hash('c')));
        assert_eq!(approved.building.facade_exemption_level, None);
        let revoked = contract.revoke_appearance(
            "plot-main-n-0".to_string(),
            third.revision,
            hash('c'),
            "Artwork withdrawn".to_string(),
        );
        assert!(revoked.building.approved_manifest_hash.is_none());
        assert_eq!(revoked.building.appearance_revision, third.revision + 1);
        assert!(revoked.building.last_facade_approved_at.is_some());
    }

    #[test]
    fn rejection_keeps_current_preset_and_owner_cannot_moderate() {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        let mut contract = seeded_contract();
        let owner = account("owner.testnet");
        let moderator = account("moderator.testnet");
        owned_test_plot(&mut contract, &owner);
        context(&owner, 0, 1_100);
        let pending = contract.propose_appearance("plot-main-n-0".to_string(), 1, hash('d'));
        assert!(catch_unwind(AssertUnwindSafe(
            || contract.approve_appearance("plot-main-n-0".to_string(), pending.clone())
        ))
        .is_err());
        context(&moderator, 0, 1_200);
        let rejected = contract.reject_appearance(
            "plot-main-n-0".to_string(),
            pending,
            "No transparent background".to_string(),
        );
        assert!(rejected.building.approved_manifest_hash.is_none());
        assert!(rejected.building.pending_appearance.is_none());
        assert!(
            rejected
                .building
                .last_appearance_decision
                .expect("decision saved")
                .status
                == AppearanceStatus::Rejected
        );
    }

    #[test]
    fn media_revalidation_preserves_timer_and_replacement_respects_cooldown() {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        let mut contract = seeded_contract();
        let owner = account("owner.testnet");
        let moderator = account("moderator.testnet");
        owned_test_plot(&mut contract, &owner);
        let logo = MediaIdentity {
            asset_hash: hash('a'),
            link: Some("https://example.com/logo".to_string()),
        };
        let billboard = MediaIdentity {
            asset_hash: hash('b'),
            link: Some("https://example.com/ad".to_string()),
        };
        context(&owner, 0, 1_100);
        let logo_proposal = contract.propose_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            0,
            1,
            logo.clone(),
        );
        let billboard_proposal = contract.propose_media(
            "plot-main-n-0".to_string(),
            MediaKind::Billboard,
            0,
            1,
            billboard.clone(),
        );
        context(&moderator, 0, 1_200);
        let view =
            contract.approve_media("plot-main-n-0".to_string(), MediaKind::Logo, logo_proposal);
        assert!(view.logo_eligible);
        assert!(!view.billboard_eligible);
        let view = contract.approve_media(
            "plot-main-n-0".to_string(),
            MediaKind::Billboard,
            billboard_proposal,
        );
        assert!(view.logo_eligible && view.billboard_eligible);
        assert_eq!(view.plot.logo.last_replacement_at, Some(1_200));
        assert_eq!(view.plot.billboard.last_replacement_at, Some(1_200));
        context(&owner, 0, 1_300);
        let changed = contract.choose_preset(
            "plot-main-n-0".to_string(),
            2,
            "#F6C85F".to_string(),
            "New Shop".to_string(),
        );
        assert_eq!(changed.building.layout_revision, 2);
        let view = contract
            .get_plot("plot-main-n-0".to_string())
            .expect("plot exists");
        assert!(!view.logo_eligible && !view.billboard_eligible);
        assert!(view.plot.logo.active.is_some() && view.plot.billboard.active.is_some());
        let same_logo = contract.propose_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            1,
            2,
            logo.clone(),
        );
        let changed_billboard = MediaIdentity {
            asset_hash: hash('b'),
            link: Some("https://example.com/new-ad".to_string()),
        };
        let new_billboard = contract.propose_media(
            "plot-main-n-0".to_string(),
            MediaKind::Billboard,
            1,
            2,
            changed_billboard.clone(),
        );
        context(&moderator, 0, 1_400);
        let view = contract.approve_media("plot-main-n-0".to_string(), MediaKind::Logo, same_logo);
        assert!(view.logo_eligible);
        assert_eq!(view.plot.logo.last_replacement_at, Some(1_200));
        assert!(catch_unwind(AssertUnwindSafe(|| contract.approve_media(
            "plot-main-n-0".to_string(),
            MediaKind::Billboard,
            new_billboard.clone()
        )))
        .is_err());
        context(&owner, 0, 1_500);
        let removed = contract.remove_media("plot-main-n-0".to_string(), MediaKind::Billboard, 2);
        assert!(!removed.billboard_eligible);
        assert_eq!(removed.plot.billboard.last_replacement_at, Some(1_200));
        let replacement = contract.propose_media(
            "plot-main-n-0".to_string(),
            MediaKind::Billboard,
            3,
            2,
            changed_billboard,
        );
        context(&moderator, 0, 1_600);
        assert!(catch_unwind(AssertUnwindSafe(|| contract.approve_media(
            "plot-main-n-0".to_string(),
            MediaKind::Billboard,
            replacement.clone()
        )))
        .is_err());
        context(&moderator, 0, 260_400);
        let view = contract.approve_media(
            "plot-main-n-0".to_string(),
            MediaKind::Billboard,
            replacement,
        );
        assert!(view.billboard_eligible);
        assert_eq!(view.plot.billboard.last_replacement_at, Some(260_400));
    }

    #[test]
    fn media_decisions_bind_owner_layout_hash_link_and_role() {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        let mut contract = seeded_contract();
        let owner = account("owner.testnet");
        let moderator = account("moderator.testnet");
        owned_test_plot(&mut contract, &owner);
        context(&owner, 0, 1_100);
        let content = MediaIdentity {
            asset_hash: hash('c'),
            link: Some("https://example.com/cafe".to_string()),
        };
        assert!(catch_unwind(AssertUnwindSafe(|| contract.propose_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            0,
            1,
            MediaIdentity {
                asset_hash: hash('c'),
                link: Some("http://example.com".to_string())
            }
        )))
        .is_err());
        for bad_link in ["https://example.com\\evil.com", "https://example.com:80/ad"] {
            assert!(catch_unwind(AssertUnwindSafe(|| contract.propose_media(
                "plot-main-n-0".to_string(),
                MediaKind::Logo,
                0,
                1,
                MediaIdentity {
                    asset_hash: hash('c'),
                    link: Some(bad_link.to_string()),
                }
            )))
            .is_err());
        }
        let proposal = contract.propose_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            0,
            1,
            content.clone(),
        );
        assert!(catch_unwind(AssertUnwindSafe(|| contract.approve_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            proposal.clone()
        )))
        .is_err());
        context(&moderator, 0, 1_200);
        let mut wrong_link = proposal.clone();
        wrong_link.content.link = Some("https://example.com/other".to_string());
        assert!(catch_unwind(AssertUnwindSafe(|| contract.approve_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            wrong_link
        )))
        .is_err());
        let view = contract.reject_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            proposal,
            "Logo is blurry".to_string(),
        );
        assert!(!view.logo_eligible);
        context(&owner, 0, 1_300);
        let next = contract.propose_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            1,
            1,
            content.clone(),
        );
        context(&moderator, 0, 1_400);
        let approved = contract.approve_media("plot-main-n-0".to_string(), MediaKind::Logo, next);
        assert!(approved.logo_eligible);
        assert!(catch_unwind(AssertUnwindSafe(|| contract.revoke_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            2,
            MediaIdentity {
                asset_hash: hash('d'),
                link: content.link.clone()
            },
            "Wrong asset".to_string()
        )))
        .is_err());
        let revoked = contract.revoke_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            2,
            content,
            "Owner request".to_string(),
        );
        assert!(!revoked.logo_eligible);
        assert_eq!(revoked.plot.logo.last_replacement_at, Some(1_400));
    }

    #[test]
    fn prepaid_plot_storage_holds_two_bounded_media_slots() {
        let mut contract = seeded_contract();
        let owner = account("owner.testnet");
        let moderator = account("moderator.testnet");
        owned_test_plot(&mut contract, &owner);
        let link = format!("https://example.com/{}", "x".repeat(236));
        assert_eq!(link.len(), 256);
        for (kind, hash_character) in [(MediaKind::Logo, 'a'), (MediaKind::Billboard, 'b')] {
            context(&owner, 0, 1_100);
            let proposal = contract.propose_media(
                "plot-main-n-0".to_string(),
                kind,
                0,
                1,
                MediaIdentity {
                    asset_hash: hash(hash_character),
                    link: Some(link.clone()),
                },
            );
            context(&moderator, 0, 1_200);
            contract.approve_media("plot-main-n-0".to_string(), kind, proposal);
        }
        context(&owner, 0, 1_300);
        let plot = contract.choose_preset(
            "plot-main-n-0".to_string(),
            2,
            "#F6C85F".to_string(),
            "Big media plot".to_string(),
        );
        let mut pending = Vec::new();
        for (kind, hash_character) in [(MediaKind::Logo, 'c'), (MediaKind::Billboard, 'd')] {
            let proposal = contract.propose_media(
                "plot-main-n-0".to_string(),
                kind,
                1,
                plot.building.layout_revision,
                MediaIdentity {
                    asset_hash: hash(hash_character),
                    link: Some(link.clone()),
                },
            );
            pending.push((kind, proposal));
        }
        context(&moderator, 0, 1_400);
        for (kind, proposal) in pending {
            contract.reject_media("plot-main-n-0".to_string(), kind, proposal, "r".repeat(240));
        }
        context(&owner, 0, 1_500);
        for (kind, hash_character) in [(MediaKind::Logo, 'e'), (MediaKind::Billboard, 'f')] {
            contract.propose_media(
                "plot-main-n-0".to_string(),
                kind,
                2,
                plot.building.layout_revision,
                MediaIdentity {
                    asset_hash: hash(hash_character),
                    link: Some(link.clone()),
                },
            );
        }
        contract.propose_appearance("plot-main-n-0".to_string(), 2, hash('a'));
        contract.set_rule("plot-main-n-0".to_string(), ParkingRule::NoParking);
        let plot = contract
            .get_plot("plot-main-n-0".to_string())
            .expect("plot exists")
            .plot;
        assert!(plot.used_storage_bytes <= plot.reserved_storage_bytes);
        assert!(plot.logo.pending.is_some() && plot.billboard.pending.is_some());
    }

    #[test]
    fn onchain_moderation_reason_has_a_utf8_byte_limit() {
        assert!(
            std::panic::catch_unwind(|| Contract::validate_moderation_reason(&"r".repeat(240)))
                .is_ok()
        );
        assert!(
            std::panic::catch_unwind(|| Contract::validate_moderation_reason(&"r".repeat(241)))
                .is_err()
        );
        assert!(
            std::panic::catch_unwind(|| Contract::validate_moderation_reason(&"🔥".repeat(60)))
                .is_ok()
        );
        assert!(
            std::panic::catch_unwind(|| Contract::validate_moderation_reason(&"🔥".repeat(61)))
                .is_err()
        );
    }

    #[test]
    fn facade_proposal_keeps_media_visible_but_publication_requires_revalidation() {
        use std::panic::{catch_unwind, AssertUnwindSafe};
        let mut contract = seeded_contract();
        let owner = account("owner.testnet");
        let moderator = account("moderator.testnet");
        owned_test_plot(&mut contract, &owner);
        let logo = MediaIdentity {
            asset_hash: hash('a'),
            link: None,
        };
        context(&owner, 0, 1_100);
        let media = contract.propose_media(
            "plot-main-n-0".to_string(),
            MediaKind::Logo,
            0,
            1,
            logo.clone(),
        );
        context(&moderator, 0, 1_200);
        contract.approve_media("plot-main-n-0".to_string(), MediaKind::Logo, media);
        context(&owner, 0, 1_300);
        let facade = contract.propose_appearance("plot-main-n-0".to_string(), 1, hash('b'));
        assert!(
            contract
                .get_plot("plot-main-n-0".to_string())
                .expect("plot")
                .logo_eligible
        );
        context(&moderator, 0, 1_400);
        contract.approve_appearance("plot-main-n-0".to_string(), facade);
        assert!(
            !contract
                .get_plot("plot-main-n-0".to_string())
                .expect("plot")
                .logo_eligible
        );
        context(&owner, 0, 1_500);
        let revalidation =
            contract.propose_media("plot-main-n-0".to_string(), MediaKind::Logo, 1, 2, logo);
        context(&moderator, 0, 1_600);
        let view =
            contract.approve_media("plot-main-n-0".to_string(), MediaKind::Logo, revalidation);
        assert!(view.logo_eligible);
        assert_eq!(view.plot.logo.last_replacement_at, Some(1_200));
        context(&owner, 0, 1_700);
        let pending = contract.propose_media(
            "plot-main-n-0".to_string(),
            MediaKind::Billboard,
            0,
            2,
            MediaIdentity {
                asset_hash: hash('c'),
                link: None,
            },
        );
        contract.change_building_type("plot-main-n-0".to_string(), BuildingType::Cafe, 1);
        context(&moderator, 0, 1_800);
        assert!(catch_unwind(AssertUnwindSafe(|| contract.approve_media(
            "plot-main-n-0".to_string(),
            MediaKind::Billboard,
            pending
        )))
        .is_err());
    }
}
