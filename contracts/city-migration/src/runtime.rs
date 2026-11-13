use near_estate_contract::{
    calculate_settlement, AccountState, AppearanceDecision, AppearanceReference, AppearanceStatus,
    BuildingState, BuildingType, Car, CarBody, CarColor, Facility, GameConfigV2, MediaApproval,
    MediaDecision, MediaDecisionStatus, MediaIdentity, MediaKind, MediaProposal, MediaSlot,
    NPCSite, ParkedCarAppearance, ParkingRule, ParkingSession, PendingRule, PlotPurchaseBreakdown,
    PlotV2, RoadId, ServiceRole, SessionTerms, Settlement, SettlementReason, Side,
};
use near_sdk::{
    borsh::{self, BorshDeserialize, BorshSerialize},
    env,
    json_types::U128,
    near, require, AccountId, NearToken, Promise,
};

use crate::{Contract, ContractExt};

const TOWER_SPACES_PER_FLOOR: u8 = 8;
const MAX_MODERATION_REASON_BYTES: usize = 240;
const TICKET_POLICY_KEY: &[u8] = b"near_estate:ticket_policy:v1";
const TICKET_USAGE_PREFIX: &[u8] = b"near_estate:ticket_usage:v1:";

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct TicketRewardPolicy {
    pub daily_owner_cap: U128,
}

impl Default for TicketRewardPolicy {
    fn default() -> Self {
        Self {
            daily_owner_cap: U128(15_000_000),
        }
    }
}

#[derive(BorshDeserialize, BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct TicketRewardUsage {
    day: u64,
    owner_paid: u128,
}

#[near(serializers = [json])]
pub struct TicketRewardStatus {
    pub daily_owner_cap: U128,
    pub owner_paid_today: U128,
    pub owner_remaining_today: U128,
    pub resets_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PlotViewV2 {
    pub plot: PlotV2,
    pub effective_rule: ParkingRule,
    pub logo_eligible: bool,
    pub billboard_eligible: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct StreetPlotViewV2 {
    pub plot: PlotViewV2,
    pub slots: Vec<Option<ParkingSession>>,
    pub car_appearances: Vec<Option<ParkedCarAppearance>>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct StreetSideViewV2 {
    pub road_id: RoadId,
    pub side: Side,
    pub plots: Vec<StreetPlotViewV2>,
}

#[near]
impl Contract {
    fn require_not_paused(&self) {
        require!(!self.inner.paused, "city is paused");
    }

    fn ticket_usage_key(plot_id: &str) -> Vec<u8> {
        let mut key = Vec::with_capacity(TICKET_USAGE_PREFIX.len() + plot_id.len());
        key.extend_from_slice(TICKET_USAGE_PREFIX);
        key.extend_from_slice(plot_id.as_bytes());
        key
    }

    fn ticket_usage(plot_id: &str, day: u64) -> u128 {
        env::storage_read(&Self::ticket_usage_key(plot_id))
            .map(|bytes| {
                TicketRewardUsage::try_from_slice(&bytes)
                    .unwrap_or_else(|_| env::panic_str("invalid ticket reward usage"))
            })
            .filter(|usage| usage.day == day)
            .map_or(0, |usage| usage.owner_paid)
    }

    pub fn get_ticket_reward_policy(&self) -> TicketRewardPolicy {
        env::storage_read(TICKET_POLICY_KEY).map_or_else(TicketRewardPolicy::default, |bytes| {
            TicketRewardPolicy::try_from_slice(&bytes)
                .unwrap_or_else(|_| env::panic_str("invalid ticket reward policy"))
        })
    }

    pub fn get_ticket_reward_status(&self, plot_id: String) -> TicketRewardStatus {
        require!(self.inner.plots.contains_key(&plot_id), "unknown plot");
        let now = Self::now_seconds();
        let day = now / 86_400;
        let cap = self.get_ticket_reward_policy().daily_owner_cap.0;
        let paid = Self::ticket_usage(&plot_id, day);
        TicketRewardStatus {
            daily_owner_cap: U128(cap),
            owner_paid_today: U128(paid),
            owner_remaining_today: U128(cap.saturating_sub(paid)),
            resets_at: (day + 1) * 86_400,
        }
    }

    pub fn set_ticket_reward_policy(&mut self, policy: TicketRewardPolicy) {
        require!(
            env::predecessor_account_id() == self.inner.admin,
            "admin only"
        );
        self.require_not_paused();
        require!(
            policy.daily_owner_cap.0 <= 1_000_000_000,
            "ticket daily owner cap exceeds 1000 coins"
        );
        let bytes = borsh::to_vec(&policy)
            .unwrap_or_else(|_| env::panic_str("ticket reward policy encoding failed"));
        env::storage_write(TICKET_POLICY_KEY, &bytes);
        self.emit(
            "ticket_reward_policy_set",
            near_sdk::serde_json::json!({"daily_owner_cap": policy.daily_owner_cap.0.to_string()}),
        );
    }

    fn require_moderator(&self) {
        require!(
            env::predecessor_account_id() == self.inner.moderator,
            "moderator only"
        );
    }

    fn registered_account(&self, account_id: &AccountId) -> AccountState {
        self.inner
            .accounts
            .get(account_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("player is not registered"))
    }

    fn owned_car(&self, car_id: u64, owner: &AccountId) -> Car {
        let car = self
            .inner
            .cars
            .get(&car_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown car"));
        require!(&car.owner == owner, "car owner only");
        car
    }

    fn take_car_id(&mut self) -> u64 {
        let id = self.inner.next_car_id;
        require!(id <= 9_000_000_000_000_000, "car ID limit reached");
        self.inner.next_car_id = id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("car ID overflow"));
        id
    }

    fn space_key(facility: Facility, location_id: &str, slot: u8) -> String {
        let prefix = if facility == Facility::Tower {
            "t"
        } else {
            "c"
        };
        format!("{prefix}:{location_id}:{slot}")
    }

    fn now_seconds() -> u64 {
        env::block_timestamp_ms() / 1_000
    }

    fn storage_quote(bytes: u32) -> u128 {
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

    fn refund_excess(caller: AccountId, deposit: u128, quote: u128) {
        let excess = deposit
            .checked_sub(quote)
            .unwrap_or_else(|| env::panic_str("deposit below quote"));
        if excess > 0 {
            Promise::new(caller)
                .transfer(NearToken::from_yoctonear(excess))
                .detach();
        }
    }

    fn emit(&self, event: &str, data: near_sdk::serde_json::Value) {
        let payload = near_sdk::serde_json::json!({
            "standard": "near_estate",
            "version": "1.0.0",
            "event": event,
            "data": [data]
        });
        env::log_str(&format!("EVENT_JSON:{payload}"));
    }

    fn write_owned_plot(&mut self, plot_id: String, mut plot: PlotV2) -> PlotV2 {
        require!(
            plot.owner.is_some(),
            "unowned plot cannot use owner storage"
        );
        let before = env::storage_usage();
        self.inner.plots.insert(plot_id.clone(), plot.clone());
        self.inner.plots.flush();
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
        self.inner.plots.insert(plot_id, plot.clone());
        self.inner.plots.flush();
        plot
    }

    fn owned_plot(&self, plot_id: &str, owner: &AccountId) -> PlotV2 {
        let plot = self
            .inner
            .plots
            .get(&plot_id.to_string())
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        require!(plot.owner.as_ref() == Some(owner), "plot owner only");
        plot
    }

    fn debit_coins(&mut self, owner: &AccountId, cost: u128, error: &str) {
        let mut account = self.registered_account(owner);
        account.balance.0 = account
            .balance
            .0
            .checked_sub(cost)
            .unwrap_or_else(|| env::panic_str(error));
        self.inner.accounts.insert(owner.clone(), account);
        self.inner.accounts.flush();
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

    fn reject_pending_appearance(building: &mut BuildingState, now: u64, reason: &str) {
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
        Self::reject_pending_appearance(building, now, reason);
        building.approved_manifest_hash = None;
        building.approved_at = None;
        Self::next_appearance_revision(building);
    }

    fn media_kind_name(kind: MediaKind) -> &'static str {
        match kind {
            MediaKind::Logo => "Logo",
            MediaKind::Billboard => "Billboard",
        }
    }

    fn media_slot(plot: &PlotV2, kind: MediaKind) -> &MediaSlot {
        match kind {
            MediaKind::Logo => &plot.logo,
            MediaKind::Billboard => &plot.billboard,
        }
    }

    fn media_slot_mut(plot: &mut PlotV2, kind: MediaKind) -> &mut MediaSlot {
        match kind {
            MediaKind::Logo => &mut plot.logo,
            MediaKind::Billboard => &mut plot.billboard,
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

    fn pending_appearance_plot(&self, plot_id: &str, expected: &AppearanceReference) -> PlotV2 {
        let plot = self
            .inner
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

    fn pending_media_plot(
        &self,
        plot_id: &str,
        kind: MediaKind,
        expected: &MediaProposal,
    ) -> PlotV2 {
        let plot = self
            .inner
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

    fn advance_layout(plot: &mut PlotV2, now: u64) {
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

    pub fn get_config(&self) -> GameConfigV2 {
        self.inner.config.clone()
    }

    pub fn get_treasury_coins(&self) -> U128 {
        self.inner.treasury_coins
    }

    pub fn chain_time_seconds(&self) -> u64 {
        Self::now_seconds()
    }

    pub fn is_paused(&self) -> bool {
        self.inner.paused
    }

    pub fn set_paused(&mut self, paused: bool) {
        require!(
            env::predecessor_account_id() == self.inner.admin,
            "admin only"
        );
        self.inner.paused = paused;
    }

    pub fn update_config(&mut self, config: GameConfigV2) {
        require!(
            env::predecessor_account_id() == self.inner.admin,
            "admin only"
        );
        self.require_not_paused();
        let next_version = self
            .inner
            .config
            .version
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("config version overflow"));
        require!(
            config.version == next_version,
            "config version must increase by one"
        );
        config.validate();
        self.inner.config = config;
        self.emit(
            "config_updated",
            near_sdk::serde_json::json!({"version": self.inner.config.version}),
        );
    }

    pub fn get_roles(&self) -> (AccountId, AccountId, AccountId) {
        (
            self.inner.admin.clone(),
            self.inner.moderator.clone(),
            self.inner.inspector.clone(),
        )
    }

    pub fn get_account(&self, account_id: AccountId) -> Option<AccountState> {
        self.inner.accounts.get(&account_id).cloned()
    }

    pub fn get_car(&self, car_id: u64) -> Option<Car> {
        self.inner.cars.get(&car_id).cloned()
    }

    pub fn get_cars(&self, account_id: AccountId) -> Vec<Car> {
        match self.inner.accounts.get(&account_id) {
            Some(account) => account
                .car_ids
                .iter()
                .filter_map(|id| self.inner.cars.get(id).cloned())
                .collect(),
            None => Vec::new(),
        }
    }

    pub fn registration_quote(&self) -> U128 {
        U128(Self::storage_quote(self.inner.config.account_storage_bytes))
    }

    #[payable]
    pub fn register_player(&mut self, body: CarBody, color: CarColor) -> Car {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        require!(
            !self.inner.accounts.contains_key(&caller),
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
            durability: self.inner.config.max_durability,
            parked_session_id: None,
        };
        let account = AccountState {
            balance: self.inner.config.starter_coins,
            car_ids: vec![car_id],
            starter_car_id: car_id,
            active_session_id: None,
            last_emergency_repair_at: None,
            burger_decal: false,
            reserved_storage_bytes: self.inner.config.account_storage_bytes,
            used_storage_bytes: 0,
        };
        let before = env::storage_usage();
        self.inner.accounts.insert(caller.clone(), account.clone());
        self.inner.cars.insert(car_id, car.clone());
        self.inner.accounts.flush();
        self.inner.cars.flush();
        let used = Self::storage_delta(before);
        require!(
            used <= account.reserved_storage_bytes,
            "registration exceeds reserved storage"
        );
        let mut account = account;
        account.used_storage_bytes = used;
        self.inner.accounts.insert(caller.clone(), account);
        self.inner.accounts.flush();
        Self::refund_excess(caller.clone(), deposit, quote);
        self.emit(
            "player_registered",
            near_sdk::serde_json::json!({
                "account_id": caller,
                "starter_car_id": car_id,
                "grant": self.inner.config.starter_coins.0.to_string()
            }),
        );
        self.emit(
            "car_minted",
            near_sdk::serde_json::json!({
                "car_id": car_id,
                "owner": caller,
                "source": "starter",
                "cost": "0"
            }),
        );
        car
    }

    pub fn buy_car(&mut self, body: CarBody, color: CarColor) -> Car {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut account = self.registered_account(&caller);
        require!(
            account.car_ids.len() < usize::from(self.inner.config.max_cars),
            "three-car limit reached"
        );
        account.balance.0 = account
            .balance
            .0
            .checked_sub(self.inner.config.buy_car_cost.0)
            .unwrap_or_else(|| env::panic_str("insufficient coins for car"));
        let car_id = self.take_car_id();
        let car = Car {
            id: car_id,
            owner: caller.clone(),
            body,
            color,
            tier: 1,
            durability: self.inner.config.max_durability,
            parked_session_id: None,
        };
        account.car_ids.push(car_id);
        let before = env::storage_usage();
        self.inner.accounts.insert(caller.clone(), account.clone());
        self.inner.cars.insert(car_id, car.clone());
        self.inner.accounts.flush();
        self.inner.cars.flush();
        let used = Self::storage_delta(before);
        account.used_storage_bytes = account
            .used_storage_bytes
            .checked_add(used)
            .unwrap_or_else(|| env::panic_str("storage usage overflow"));
        require!(
            account.used_storage_bytes <= account.reserved_storage_bytes,
            "car exceeds prepaid storage reserve"
        );
        self.inner.accounts.insert(caller.clone(), account);
        self.inner.accounts.flush();
        self.emit(
            "car_minted",
            near_sdk::serde_json::json!({
                "car_id": car_id, "owner": caller, "source": "purchase",
                "cost": self.inner.config.buy_car_cost.0.to_string()
            }),
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
            new_durability <= self.inner.config.max_durability,
            "repair exceeds maximum durability"
        );
        let cost = self
            .inner
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
        self.inner.accounts.insert(caller, account);
        self.inner.cars.insert(car_id, car.clone());
        self.emit(
            "car_repaired",
            near_sdk::serde_json::json!({"car_id": car_id, "points": points, "cost": cost.to_string()}),
        );
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
        let price = self.inner.config.tier_upgrade_costs[usize::from(car.tier - 1)].0;
        account.balance.0 = account
            .balance
            .0
            .checked_sub(price)
            .unwrap_or_else(|| env::panic_str("insufficient coins for upgrade"));
        car.tier = car
            .tier
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("car tier overflow"));
        self.inner.accounts.insert(caller, account);
        self.inner.cars.insert(car_id, car.clone());
        self.emit(
            "car_upgraded",
            near_sdk::serde_json::json!({"car_id": car_id, "tier": car.tier, "cost": price.to_string()}),
        );
        car
    }

    pub fn emergency_repair(&mut self) -> Car {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut account = self.registered_account(&caller);
        let park_cost = self.inner.config.park_durability_cost;
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
            .inner
            .config
            .repair_cost_per_point
            .0
            .checked_mul(u128::from(fewest_missing_points))
            .unwrap_or_else(|| env::panic_str("emergency repair price overflow"));
        require!(
            account.balance.0 < cheapest_repair,
            "can afford a repair to parking durability"
        );
        let now = Self::now_seconds();
        if let Some(last) = account.last_emergency_repair_at {
            let eligible_at = last
                .checked_add(u64::from(
                    self.inner.config.emergency_repair_cooldown_seconds,
                ))
                .unwrap_or_else(|| env::panic_str("emergency repair time overflow"));
            require!(now >= eligible_at, "emergency repair cooldown active");
        }
        let mut car = self.owned_car(account.starter_car_id, &caller);
        let points = park_cost
            .checked_sub(car.durability)
            .unwrap_or_else(|| env::panic_str("starter car already has parking durability"));
        car.durability = park_cost;
        account.last_emergency_repair_at = Some(now);
        self.inner.accounts.insert(caller, account);
        self.inner.cars.insert(car.id, car.clone());
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
            .checked_sub(self.inner.config.burger_decal_cost.0)
            .unwrap_or_else(|| env::panic_str("insufficient coins for burger decal"));
        account.burger_decal = true;
        self.inner.accounts.insert(caller.clone(), account);
        self.emit(
            "cosmetic_bought",
            near_sdk::serde_json::json!({
                "account_id": caller, "cosmetic": "burger_decal",
                "cost": self.inner.config.burger_decal_cost.0.to_string()
            }),
        );
    }

    pub fn plot_count(&self) -> u16 {
        self.inner.plot_count
    }

    pub fn npc_site_count(&self) -> u8 {
        self.inner.npc_site_count
    }

    pub fn get_npc_site(&self, site_id: String) -> Option<NPCSite> {
        self.inner.npc_sites.get(&site_id).cloned()
    }

    pub fn get_npc_sites(&self, from_index: u8, limit: u8) -> Vec<NPCSite> {
        require!(limit <= 20, "NPC site page limit exceeds 20");
        let end = self
            .inner
            .npc_site_count
            .min(from_index.saturating_add(limit));
        (from_index..end)
            .filter_map(|index| {
                self.inner
                    .npc_site_ids
                    .get(&index)
                    .and_then(|id| self.inner.npc_sites.get(id).cloned())
            })
            .collect()
    }

    pub fn add_horse_course_site(&mut self) -> NPCSite {
        require!(
            env::predecessor_account_id() == self.inner.admin,
            "admin only"
        );
        self.require_not_paused();
        let site = NPCSite {
            id: "npc-harbor-horse-course".to_owned(),
            road_id: RoadId::Harbor,
            side: Side::South,
            frontage_index: 10,
            role: ServiceRole::HorseCourse,
            name: "Harbor Horse Course".to_owned(),
            capacity: 0,
        };
        if let Some(existing) = self.inner.npc_sites.get(&site.id).cloned() {
            require!(
                existing.road_id == site.road_id
                    && existing.side == site.side
                    && existing.frontage_index == site.frontage_index
                    && existing.role == site.role
                    && existing.name == site.name
                    && existing.capacity == 0,
                "horse course site differs from expected layout"
            );
            return existing;
        }
        require!(
            self.inner.city_version == 2
                && self.inner.plot_count == 100
                && self.inner.npc_site_count == 7,
            "unexpected city layout for horse course"
        );
        for index in 0..self.inner.npc_site_count {
            let id = self
                .inner
                .npc_site_ids
                .get(&index)
                .unwrap_or_else(|| env::panic_str("NPC site index missing"));
            let other = self
                .inner
                .npc_sites
                .get(id)
                .unwrap_or_else(|| env::panic_str("NPC site record missing"));
            require!(
                other.road_id != site.road_id
                    || other.side != site.side
                    || other.frontage_index != site.frontage_index,
                "horse course frontage is occupied"
            );
        }
        self.inner.npc_sites.insert(site.id.clone(), site.clone());
        self.inner.npc_site_ids.insert(7, site.id.clone());
        self.inner.npc_site_count = 8;
        self.inner.npc_sites.flush();
        self.inner.npc_site_ids.flush();
        self.emit(
            "npc_site_seeded",
            near_sdk::serde_json::json!({"site_id": site.id, "role": "game_owned"}),
        );
        site
    }

    pub fn get_plot(&self, plot_id: String) -> Option<PlotViewV2> {
        self.inner.plots.get(&plot_id).cloned().map(|plot| {
            let effective_rule = plot.effective_rule(Self::now_seconds());
            PlotViewV2 {
                logo_eligible: plot.logo.eligible(plot.building.layout_revision),
                billboard_eligible: plot.billboard_supported()
                    && plot.billboard.eligible(plot.building.layout_revision),
                plot,
                effective_rule,
            }
        })
    }

    pub fn get_plots(&self, from_index: u16, limit: u8) -> Vec<PlotViewV2> {
        require!(limit <= 50, "plot page limit exceeds 50");
        let end = self
            .inner
            .plot_count
            .min(from_index.saturating_add(u16::from(limit)));
        (from_index..end)
            .filter_map(|index| {
                self.inner
                    .plot_ids
                    .get(&index)
                    .and_then(|id| self.get_plot(id.clone()))
            })
            .collect()
    }

    pub fn get_session(&self, session_id: u64) -> Option<ParkingSession> {
        self.inner.sessions.get(&session_id).cloned()
    }

    pub fn get_space_session(&self, plot_id: String, slot: u8) -> Option<ParkingSession> {
        let plot = self.inner.plots.get(&plot_id)?;
        if slot >= plot.frontage_units {
            return None;
        }
        self.inner
            .space_sessions
            .get(&format!("c:{plot_id}:{slot}"))
            .and_then(|id| self.get_session(*id))
    }

    pub fn get_street_side(&self, road_id: RoadId, side: Side) -> StreetSideViewV2 {
        let plots = (0..10)
            .filter_map(|index| {
                let id = format!("plot-{}-{}-{index}", road_id.as_str(), side.short());
                self.get_plot(id.clone()).map(|plot| {
                    let slots: Vec<_> = (0..plot.plot.frontage_units)
                        .map(|slot| self.get_space_session(id.clone(), slot))
                        .collect();
                    let car_appearances = slots
                        .iter()
                        .map(|session| {
                            session.as_ref().and_then(|session| {
                                self.inner.cars.get(&session.car_id).and_then(|car| {
                                    (car.parked_session_id == Some(session.id)).then_some(
                                        ParkedCarAppearance {
                                            id: car.id,
                                            body: car.body,
                                            color: car.color,
                                        },
                                    )
                                })
                            })
                        })
                        .collect();
                    StreetPlotViewV2 {
                        plot,
                        slots,
                        car_appearances,
                    }
                })
            })
            .collect();
        StreetSideViewV2 {
            road_id,
            side,
            plots,
        }
    }

    pub fn plot_purchase_quote(&self, plot_id: String) -> U128 {
        self.plot_purchase_breakdown(plot_id).total_yocto
    }

    pub fn plot_purchase_breakdown(&self, plot_id: String) -> PlotPurchaseBreakdown {
        let plot = self
            .inner
            .plots
            .get(&plot_id)
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        require!(plot.owner.is_none(), "plot already owned");
        let price = self.inner.config.price_yocto(plot);
        let storage_reserve = Self::storage_quote(self.inner.config.plot_storage_bytes);
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
    pub fn buy_plot(&mut self, plot_id: String) -> PlotV2 {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        self.registered_account(&caller);
        let mut plot = self
            .inner
            .plots
            .get(&plot_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        require!(plot.owner.is_none(), "plot already owned");
        let price = self.inner.config.price_yocto(&plot);
        let reserve = Self::storage_quote(self.inner.config.plot_storage_bytes);
        let required = price
            .checked_add(reserve)
            .unwrap_or_else(|| env::panic_str("plot purchase price overflow"));
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= required, "insufficient plot purchase deposit");
        let before = env::storage_usage();
        plot.owner = Some(caller.clone());
        plot.reserved_storage_bytes = self.inner.config.plot_storage_bytes;
        self.inner.plots.insert(plot_id.clone(), plot.clone());
        self.inner.plots.flush();
        let used = Self::storage_delta(before);
        require!(
            used <= plot.reserved_storage_bytes,
            "plot ownership exceeds storage reserve"
        );
        plot.used_storage_bytes = used;
        self.inner.plots.insert(plot_id.clone(), plot.clone());
        self.inner.plots.flush();
        Self::refund_excess(caller.clone(), deposit, required);
        self.emit(
            "plot_bought",
            near_sdk::serde_json::json!({
                "plot_id": plot_id,
                "owner": caller,
                "price_yocto": price.to_string()
            }),
        );
        plot
    }

    pub fn set_rule(&mut self, plot_id: String, rule: ParkingRule) -> PlotViewV2 {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut plot = self
            .inner
            .plots
            .get(&plot_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        require!(plot.owner.as_ref() == Some(&caller), "plot owner only");
        if let ParkingRule::Meter { rate_per_hour } = &rule {
            require!(
                rate_per_hour.0 <= self.inner.config.meter_rate_max_per_hour.0,
                "meter rate exceeds maximum"
            );
        }
        let now = Self::now_seconds();
        plot.promote_pending(now);
        let effective_at = now
            .checked_add(u64::from(self.inner.config.rule_delay_seconds))
            .unwrap_or_else(|| env::panic_str("rule effective time overflow"));
        plot.pending_rule = Some(PendingRule { rule, effective_at });
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit(
            "rule_scheduled",
            near_sdk::serde_json::json!({
                "plot_id": plot_id,
                "effective_at": effective_at
            }),
        );
        PlotViewV2 {
            logo_eligible: plot.logo.eligible(plot.building.layout_revision),
            billboard_eligible: plot.billboard_supported()
                && plot.billboard.eligible(plot.building.layout_revision),
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
    ) -> PlotV2 {
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
        let now = Self::now_seconds();
        Self::activate_preset(building, now, "Preset selected");
        Self::advance_layout(&mut plot, now);
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit(
            "building_updated",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "revision": plot.building.appearance_revision,
                "change": "preset"
            }),
        );
        plot
    }

    pub fn choose_design(&mut self, plot_id: String, choice: u8) -> PlotV2 {
        self.require_not_paused();
        require!(choice < 5, "building design choice must be 0 through 4");
        let caller = env::predecessor_account_id();
        let mut plot = self.owned_plot(&plot_id, &caller);
        if plot.design_choice == choice {
            return plot;
        }
        plot.design_choice = choice;
        let now = Self::now_seconds();
        Self::activate_preset(&mut plot.building, now, "Building design changed");
        Self::advance_layout(&mut plot, now);
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit(
            "building_updated",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "revision": plot.building.appearance_revision,
                "change": "design", "design_choice": choice
            }),
        );
        plot
    }

    pub fn change_building_type(
        &mut self,
        plot_id: String,
        building_type: BuildingType,
        variant: u8,
    ) -> PlotV2 {
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
        let cost = self.inner.config.change_building_type_cost.0;
        self.debit_coins(&caller, cost, "insufficient coins for building type");
        plot.building.building_type = building_type;
        plot.building.variant = variant;
        let now = Self::now_seconds();
        Self::activate_preset(&mut plot.building, now, "Building type changed");
        Self::advance_layout(&mut plot, now);
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit(
            "building_updated",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "revision": plot.building.appearance_revision,
                "change": "type", "cost": cost.to_string()
            }),
        );
        plot
    }

    pub fn upgrade_building(&mut self, plot_id: String) -> PlotV2 {
        self.require_not_paused();
        let caller = env::predecessor_account_id();
        let mut plot = self.owned_plot(&plot_id, &caller);
        let old_level = plot.building.level;
        require!((1..4).contains(&old_level), "building is already level 4");
        let next_level = old_level
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("building level overflow"));
        let cost = self.inner.config.building_upgrade_costs[usize::from(old_level - 1)].0;
        self.debit_coins(&caller, cost, "insufficient coins for building upgrade");
        plot.building.level = next_level;
        plot.building.facade_exemption_level = Some(next_level);
        let now = Self::now_seconds();
        Self::activate_preset(&mut plot.building, now, "Building level changed");
        Self::advance_layout(&mut plot, now);
        let plot = self.write_owned_plot(plot_id.clone(), plot);
        self.emit(
            "building_updated",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "revision": plot.building.appearance_revision,
                "change": "level", "level": next_level, "cost": cost.to_string()
            }),
        );
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
        Self::reject_pending_appearance(&mut plot.building, now, "Superseded");
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
        self.emit(
            "appearance_proposed",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "revision": reference.revision,
                "manifest_hash": reference.manifest_hash
            }),
        );
        reference
    }

    pub fn approve_appearance(&mut self, plot_id: String, expected: AppearanceReference) -> PlotV2 {
        self.require_moderator();
        self.require_not_paused();
        let mut plot = self.pending_appearance_plot(&plot_id, &expected);
        let now = Self::now_seconds();
        if let Some(last) = plot.building.last_facade_approved_at {
            let next = last
                .checked_add(u64::from(self.inner.config.facade_cooldown_seconds))
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
        self.emit(
            "appearance_approved",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "revision": expected.revision,
                "manifest_hash": expected.manifest_hash
            }),
        );
        plot
    }

    pub fn reject_appearance(
        &mut self,
        plot_id: String,
        expected: AppearanceReference,
        reason: String,
    ) -> PlotV2 {
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
        self.emit(
            "appearance_rejected",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "revision": expected.revision,
                "manifest_hash": expected.manifest_hash
            }),
        );
        plot
    }

    pub fn revoke_appearance(
        &mut self,
        plot_id: String,
        expected_revision: u64,
        expected_manifest_hash: String,
        reason: String,
    ) -> PlotV2 {
        self.require_moderator();
        self.require_not_paused();
        Self::validate_moderation_reason(&reason);
        let mut plot = self
            .inner
            .plots
            .get(&plot_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        let owner = plot
            .owner
            .clone()
            .unwrap_or_else(|| env::panic_str("unowned plot"));
        require!(
            plot.building.appearance_revision >= expected_revision
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
        self.emit(
            "appearance_revoked",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "revision": revision,
                "manifest_hash": expected_manifest_hash
            }),
        );
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
        self.emit(
            "media_proposed",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "kind": Self::media_kind_name(kind),
                "revision": revision, "asset_hash": proposal.content.asset_hash
            }),
        );
        proposal
    }

    pub fn approve_media(
        &mut self,
        plot_id: String,
        kind: MediaKind,
        expected: MediaProposal,
    ) -> PlotViewV2 {
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
                    .checked_add(u64::from(self.inner.config.logo_cooldown_seconds))
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
        self.emit(
            "media_approved",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "kind": Self::media_kind_name(kind),
                "revision": expected.revision,
                "asset_hash": expected.content.asset_hash
            }),
        );
        self.get_plot(plot_id)
            .unwrap_or_else(|| env::panic_str("approved plot missing"))
    }

    pub fn reject_media(
        &mut self,
        plot_id: String,
        kind: MediaKind,
        expected: MediaProposal,
        reason: String,
    ) -> PlotViewV2 {
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
        self.emit(
            "media_rejected",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "kind": Self::media_kind_name(kind),
                "revision": expected.revision,
                "asset_hash": expected.content.asset_hash
            }),
        );
        self.get_plot(plot_id)
            .unwrap_or_else(|| env::panic_str("rejected plot missing"))
    }

    pub fn remove_media(
        &mut self,
        plot_id: String,
        kind: MediaKind,
        expected_media_revision: u64,
    ) -> PlotViewV2 {
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
        self.emit(
            "media_removed",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "kind": Self::media_kind_name(kind),
                "revision": revision
            }),
        );
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
    ) -> PlotViewV2 {
        self.require_moderator();
        self.require_not_paused();
        Self::validate_moderation_reason(&reason);
        let mut plot = self
            .inner
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
            slot.revision >= expected_media_revision
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
        self.emit(
            "media_revoked",
            near_sdk::serde_json::json!({
                "plot_id": plot_id, "kind": Self::media_kind_name(kind),
                "revision": revision,
                "asset_hash": expected_content.asset_hash
            }),
        );
        self.get_plot(plot_id)
            .unwrap_or_else(|| env::panic_str("revoked plot missing"))
    }

    pub fn get_tower_space_session(&self, site_id: String, space: u8) -> Option<ParkingSession> {
        let site = self.inner.npc_sites.get(&site_id)?;
        if site.role != ServiceRole::ParkingTower || space >= site.capacity {
            return None;
        }
        self.inner
            .space_sessions
            .get(&format!("t:{site_id}:{space}"))
            .and_then(|id| self.get_session(*id))
    }

    fn tower_site(&self, site_id: &str) -> &NPCSite {
        let site = self
            .inner
            .npc_sites
            .get(&site_id.to_string())
            .unwrap_or_else(|| env::panic_str("unknown NPC site"));
        require!(
            site.role == ServiceRole::ParkingTower,
            "NPC site is not a parking tower"
        );
        site
    }

    fn tower_floor_range(&self, site_id: &str, floor: u8) -> std::ops::Range<u8> {
        let site = self.tower_site(site_id);
        require!(
            site.capacity % TOWER_SPACES_PER_FLOOR == 0,
            "tower floor layout is invalid"
        );
        require!(
            floor < site.capacity / TOWER_SPACES_PER_FLOOR,
            "invalid tower floor"
        );
        floor * TOWER_SPACES_PER_FLOOR..(floor + 1) * TOWER_SPACES_PER_FLOOR
    }

    fn tower_space_open(&self, site_id: &str, space: u8, now: u64) -> bool {
        let key = Self::space_key(Facility::Tower, site_id, space);
        self.inner
            .space_sessions
            .get(&key)
            .and_then(|id| self.inner.sessions.get(id))
            .is_none_or(|session| now >= session.expires_at)
    }

    pub fn get_tower_floor_sessions(
        &self,
        site_id: String,
        floor: u8,
    ) -> Vec<Option<ParkingSession>> {
        self.tower_floor_range(&site_id, floor)
            .map(|space| self.get_tower_space_session(site_id.clone(), space))
            .collect()
    }

    pub fn get_tower_availability(&self, site_id: String) -> u8 {
        let capacity = self.tower_site(&site_id).capacity;
        let now = Self::now_seconds();
        let open = (0..capacity)
            .filter(|space| self.tower_space_open(&site_id, *space, now))
            .count();
        u8::try_from(open).unwrap_or_else(|_| env::panic_str("tower availability overflow"))
    }

    pub fn get_tower_open_space(&self, site_id: String) -> Option<u8> {
        let capacity = self.tower_site(&site_id).capacity;
        let now = Self::now_seconds();
        (0..capacity).find(|space| self.tower_space_open(&site_id, *space, now))
    }

    pub fn get_tower_floor_availability(&self, site_id: String) -> Vec<u8> {
        let capacity = self.tower_site(&site_id).capacity;
        require!(
            capacity % TOWER_SPACES_PER_FLOOR == 0,
            "tower floor layout is invalid"
        );
        let now = Self::now_seconds();
        (0..capacity / TOWER_SPACES_PER_FLOOR)
            .map(|floor| {
                let open = self
                    .tower_floor_range(&site_id, floor)
                    .filter(|space| self.tower_space_open(&site_id, *space, now))
                    .count();
                u8::try_from(open)
                    .unwrap_or_else(|_| env::panic_str("tower floor availability overflow"))
            })
            .collect()
    }

    pub fn get_tower_open_space_on_floor(&self, site_id: String, floor: u8) -> Option<u8> {
        let now = Self::now_seconds();
        self.tower_floor_range(&site_id, floor)
            .find(|space| self.tower_space_open(&site_id, *space, now))
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
        location_id: String,
        slot: u8,
        facility: Facility,
    ) -> ParkingSession {
        self.require_not_paused();
        let plot = if facility == Facility::Curb {
            let plot = self
                .inner
                .plots
                .get(&location_id)
                .cloned()
                .unwrap_or_else(|| env::panic_str("unknown plot"));
            plot.check_slot(slot);
            Some(plot)
        } else {
            let site = self
                .inner
                .npc_sites
                .get(&location_id)
                .unwrap_or_else(|| env::panic_str("unknown NPC site"));
            require!(
                site.role == ServiceRole::ParkingTower,
                "NPC site is not a parking tower"
            );
            require!(slot < site.capacity, "tower space index out of bounds");
            None
        };
        let caller = env::predecessor_account_id();
        let now = Self::now_seconds();
        let mut account = self.registered_account(&caller);
        if let Some(active_id) = account.active_session_id {
            let active = self
                .inner
                .sessions
                .get(&active_id)
                .cloned()
                .unwrap_or_else(|| env::panic_str("active session missing"));
            require!(
                now >= active.expires_at,
                "account already has an earning car"
            );
            self.settle_session(active_id, SettlementReason::Expire, None, None);
            account = self.registered_account(&caller);
        }
        let key = Self::space_key(facility, &location_id, slot);
        if let Some(existing_id) = self.inner.space_sessions.get(&key).copied() {
            let existing = self
                .inner
                .sessions
                .get(&existing_id)
                .cloned()
                .unwrap_or_else(|| env::panic_str("occupied session missing"));
            require!(now >= existing.expires_at, "parking space is occupied");
            self.settle_session(existing_id, SettlementReason::Expire, None, None);
        }
        require!(
            account.active_session_id.is_none(),
            "account already has an earning car"
        );
        require!(
            !self.inner.space_sessions.contains_key(&key),
            "parking space is occupied"
        );
        let mut car = self.owned_car(car_id, &caller);
        require!(car.parked_session_id.is_none(), "car already parked");
        require!(
            car.durability >= self.inner.config.park_durability_cost,
            "car needs repair before parking"
        );
        let (legal, meter_rate, meter_recipient) = if let Some(plot) = plot {
            require!(
                plot.owner.as_ref() != Some(&caller),
                "cannot earn on your own curb"
            );
            match plot.effective_rule(now) {
                ParkingRule::Free => (true, U128(0), None),
                ParkingRule::Meter { rate_per_hour } => (true, rate_per_hour, plot.owner),
                ParkingRule::ColorOnly { color } => (car.color == color, U128(0), None),
                ParkingRule::NoParking => (false, U128(0), None),
            }
        } else {
            (true, U128(0), None)
        };
        let tier_index = usize::from(
            car.tier
                .checked_sub(1)
                .unwrap_or_else(|| env::panic_str("invalid car tier")),
        );
        let tier_multiplier = *self
            .inner
            .config
            .tier_multiplier_bps
            .get(tier_index)
            .unwrap_or_else(|| env::panic_str("invalid car tier"));
        let terms = SessionTerms {
            config_version: self.inner.config.version,
            base_rate_per_hour: self.inner.config.base_rate_per_hour,
            tier_multiplier_bps: tier_multiplier,
            legality_multiplier_bps: if legal {
                10_000
            } else {
                self.inner.config.illegal_multiplier_bps
            },
            facility_multiplier_bps: if facility == Facility::Tower {
                self.inner.config.tower_multiplier_bps
            } else {
                10_000
            },
            meter_rate_per_hour: meter_rate,
            earn_cap_seconds: self.inner.config.earn_cap_seconds,
            ticket_recipient_bps: self.inner.config.ticket_recipient_bps,
            meter_recipient,
        };
        let earn_until = now
            .checked_add(u64::from(self.inner.config.earn_cap_seconds))
            .unwrap_or_else(|| env::panic_str("earning deadline overflow"));
        let expires_at = earn_until
            .checked_add(u64::from(self.inner.config.expiry_grace_seconds))
            .unwrap_or_else(|| env::panic_str("expiry deadline overflow"));
        let id = self.inner.next_session_id;
        require!(id <= 9_000_000_000_000_000, "session ID limit reached");
        self.inner.next_session_id = id
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("session ID overflow"));
        let session = ParkingSession {
            id,
            car_id,
            driver: caller.clone(),
            location_id: location_id.clone(),
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
            .checked_sub(self.inner.config.park_durability_cost)
            .unwrap_or_else(|| env::panic_str("parking durability underflow"));
        car.parked_session_id = Some(id);
        account.active_session_id = Some(id);
        let before = env::storage_usage();
        self.inner.sessions.insert(id, session.clone());
        self.inner.space_sessions.insert(key, id);
        self.inner.cars.insert(car_id, car);
        self.inner.accounts.insert(caller.clone(), account.clone());
        self.inner.sessions.flush();
        self.inner.space_sessions.flush();
        self.inner.cars.flush();
        self.inner.accounts.flush();
        let growth = Self::storage_delta(before);
        account.used_storage_bytes = account
            .used_storage_bytes
            .checked_add(growth)
            .unwrap_or_else(|| env::panic_str("account storage accounting overflow"));
        require!(
            account.used_storage_bytes <= account.reserved_storage_bytes,
            "parking session exceeds prepaid storage reserve"
        );
        self.inner.accounts.insert(caller.clone(), account);
        self.inner.accounts.flush();
        self.emit(
            "parked",
            near_sdk::serde_json::json!({
                "session_id": id, "car_id": car_id, "driver": caller,
                "location_id": location_id, "slot": slot,
                "facility": if facility == Facility::Tower { "Tower" } else { "Curb" },
                "legal": legal, "expires_at": expires_at
            }),
        );
        session
    }

    pub fn collect(&mut self, expected_session_id: u64) -> Settlement {
        let session = self
            .inner
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
        self.settle_session(expected_session_id, SettlementReason::Collect, None, None)
    }

    pub fn settle_expired(&mut self, expected_session_id: u64) -> Settlement {
        let session = self
            .inner
            .sessions
            .get(&expected_session_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown parking session"));
        require!(
            Self::now_seconds() >= session.expires_at,
            "session has not expired"
        );
        self.settle_session(expected_session_id, SettlementReason::Expire, None, None)
    }

    pub fn ticket(&mut self, plot_id: String, slot: u8, expected_session_id: u64) -> Settlement {
        let caller = env::predecessor_account_id();
        let mut plot = self
            .inner
            .plots
            .get(&plot_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        plot.check_slot(slot);
        require!(plot.owner.as_ref() == Some(&caller), "plot owner only");
        let now = Self::now_seconds();
        require!(now >= plot.ticket_cooldown_until, "ticket cooldown active");
        let session = self
            .inner
            .sessions
            .get(&expected_session_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown parking session"));
        self.require_session_in_space(&session, &plot_id, slot);
        require!(!session.legal, "legal parking cannot be ticketed");
        require!(
            now < session.expires_at,
            "session expired; call settle_expired"
        );
        require!(session.driver != caller, "cannot ticket your own car");
        let cooldown_until = now
            .checked_add(u64::from(self.inner.config.ticket_cooldown_seconds))
            .unwrap_or_else(|| env::panic_str("ticket cooldown overflow"));
        let day = now / 86_400;
        let prior_paid = Self::ticket_usage(&plot_id, day);
        let daily_cap = self.get_ticket_reward_policy().daily_owner_cap.0;
        let available = daily_cap.saturating_sub(prior_paid);
        let gross_reward = calculate_settlement(&session, now, SettlementReason::Ticket)
            .recipient_payout
            .0;
        let owner_reward = gross_reward.min(available);
        let settlement = self.settle_session(
            expected_session_id,
            SettlementReason::Ticket,
            Some(caller),
            Some(owner_reward),
        );
        if owner_reward > 0 {
            let usage = TicketRewardUsage {
                day,
                owner_paid: prior_paid
                    .checked_add(owner_reward)
                    .unwrap_or_else(|| env::panic_str("ticket reward usage overflow")),
            };
            let bytes = borsh::to_vec(&usage)
                .unwrap_or_else(|_| env::panic_str("ticket reward usage encoding failed"));
            env::storage_write(&Self::ticket_usage_key(&plot_id), &bytes);
        }
        plot.ticket_cooldown_until = cooldown_until;
        self.write_owned_plot(plot_id, plot);
        settlement
    }

    pub fn inspect(
        &mut self,
        plot_id: String,
        slot: u8,
        expected_session_id: u64,
    ) -> Option<Settlement> {
        require!(
            env::predecessor_account_id() == self.inner.inspector,
            "inspector only"
        );
        let plot = self
            .inner
            .plots
            .get(&plot_id)
            .unwrap_or_else(|| env::panic_str("unknown plot"));
        plot.check_slot(slot);
        let now = Self::now_seconds();
        let mut session = self
            .inner
            .sessions
            .get(&expected_session_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown parking session"));
        self.require_session_in_space(&session, &plot_id, slot);
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
                >= u64::from(self.inner.config.inspector_min_age_seconds),
            "illegal session is too new to inspect"
        );
        if now >= self.inner.inspector_window_until {
            self.inner.inspector_window_until = now
                .checked_add(u64::from(self.inner.config.inspector_window_seconds))
                .unwrap_or_else(|| env::panic_str("inspector window overflow"));
            self.inner.inspector_attempts_in_window = 0;
        }
        require!(
            self.inner.inspector_attempts_in_window
                < self.inner.config.inspector_max_attempts_per_window,
            "inspector patrol limit reached"
        );
        self.inner.inspector_attempts_in_window = self
            .inner
            .inspector_attempts_in_window
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("inspector attempt overflow"));
        session.inspector_attempted = true;
        self.inner.sessions.insert(expected_session_id, session);
        self.inner.sessions.flush();
        let roll = Self::inspection_roll(&env::random_seed(), expected_session_id);
        let success = roll < u64::from(self.inner.config.inspector_chance_bps);
        self.emit(
            "inspection_attempted",
            near_sdk::serde_json::json!({"session_id": expected_session_id, "success": success}),
        );
        if success {
            Some(self.settle_session(expected_session_id, SettlementReason::Ticket, None, None))
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

    fn require_session_in_space(&self, session: &ParkingSession, plot_id: &str, slot: u8) {
        require!(
            session.facility == Facility::Curb
                && session.location_id == plot_id
                && session.slot == slot,
            "session is not in requested space"
        );
        require!(
            self.inner
                .space_sessions
                .get(&Self::space_key(Facility::Curb, plot_id, slot))
                == Some(&session.id),
            "stale parking session"
        );
    }

    fn settle_session(
        &mut self,
        session_id: u64,
        reason: SettlementReason,
        ticket_recipient: Option<AccountId>,
        owner_ticket_reward: Option<u128>,
    ) -> Settlement {
        let session = self
            .inner
            .sessions
            .get(&session_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown parking session"));
        let key = Self::space_key(session.facility, &session.location_id, session.slot);
        require!(
            self.inner.space_sessions.get(&key) == Some(&session_id),
            "parking occupancy invariant failed"
        );
        let settlement = calculate_settlement(&session, Self::now_seconds(), reason);
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
        self.inner.accounts.insert(session.driver.clone(), driver);
        self.inner.cars.insert(session.car_id, car);
        self.inner.sessions.remove(&session_id);
        self.inner.space_sessions.remove(&key);
        require!(
            owner_ticket_reward.is_none()
                || matches!(reason, SettlementReason::Ticket) && recipient.is_some(),
            "ticket reward override requires an owner"
        );
        let owner_payout = if recipient.is_some() {
            owner_ticket_reward.unwrap_or(settlement.recipient_payout.0)
        } else {
            0
        };
        require!(
            owner_payout <= settlement.recipient_payout.0,
            "ticket owner reward exceeds settlement"
        );
        let treasury_payout = settlement.recipient_payout.0 - owner_payout;
        let owner_account = if owner_payout > 0 {
            recipient.as_ref().map(ToString::to_string)
        } else {
            None
        };
        if owner_payout > 0 {
            if let Some(account_id) = recipient {
                let mut owner = self.registered_account(&account_id);
                owner.balance.0 = owner
                    .balance
                    .0
                    .checked_add(owner_payout)
                    .unwrap_or_else(|| env::panic_str("recipient balance overflow"));
                self.inner.accounts.insert(account_id, owner);
            }
        }
        if treasury_payout > 0 {
            self.inner.treasury_coins.0 = self
                .inner
                .treasury_coins
                .0
                .checked_add(treasury_payout)
                .unwrap_or_else(|| env::panic_str("treasury balance overflow"));
        }
        self.inner.accounts.flush();
        self.inner.cars.flush();
        self.inner.sessions.flush();
        self.inner.space_sessions.flush();
        let released = before.saturating_sub(env::storage_usage());
        let released =
            u32::try_from(released).unwrap_or_else(|_| env::panic_str("released storage overflow"));
        let mut driver = self.registered_account(&session.driver);
        driver.used_storage_bytes = driver.used_storage_bytes.saturating_sub(released);
        self.inner.accounts.insert(session.driver.clone(), driver);
        self.inner.accounts.flush();
        let event = match reason {
            SettlementReason::Collect => "collected",
            SettlementReason::Expire => "expired",
            SettlementReason::Ticket => "ticketed",
        };
        self.emit(
            event,
            near_sdk::serde_json::json!({
                "session_id": session_id, "location_id": session.location_id, "slot": session.slot,
                "facility": if session.facility == Facility::Tower { "Tower" } else { "Curb" },
                "gross": settlement.gross.0.to_string(),
                "driver_payout": settlement.driver_payout.0.to_string(),
                "recipient_payout": settlement.recipient_payout.0.to_string(),
                "owner_payout": owner_payout.to_string(),
                "treasury_payout": treasury_payout.to_string(),
                "owner_account": owner_account,
                "forfeited": settlement.forfeited.0.to_string()
            }),
        );
        settlement
    }
}
