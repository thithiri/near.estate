use near_sdk::{env, json_types::U128, near, require, AccountId};

use crate::world::{
    BuildingState, BuildingType, MediaSlot, ParkingRule, PendingRule, Plot, RoadId, Side,
};
use crate::GameConfig;

/// Target value layout for the version-2 city. The deployed `Plot` stays intact
/// until the one-time migration rewrites every plot value under the new layout.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PlotV2 {
    pub id: String,
    pub road_id: RoadId,
    pub side: Side,
    pub index: u8,
    pub frontage_units: u8,
    /// Index into the five curated designs for this plot's frontage width.
    pub design_choice: u8,
    pub corner: bool,
    pub owner: Option<AccountId>,
    pub rule: ParkingRule,
    pub pending_rule: Option<PendingRule>,
    pub building: BuildingState,
    pub logo: MediaSlot,
    pub billboard: MediaSlot,
    pub ticket_cooldown_until: u64,
    pub reserved_storage_bytes: u32,
    pub used_storage_bytes: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PlotSeedV2 {
    pub road_id: RoadId,
    pub side: Side,
    pub index: u8,
    pub frontage_units: u8,
    pub building_type: BuildingType,
    pub variant: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct GameConfigV2 {
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
    pub plot_unit_price_yocto: U128,
    pub corner_price_bps: u16,
    pub tower_capacity: u8,
    pub burger_decal_cost: U128,
    pub logo_cooldown_seconds: u32,
    pub facade_cooldown_seconds: u32,
    pub emergency_repair_cooldown_seconds: u32,
}

impl GameConfigV2 {
    pub fn validate(&self) {
        require!(
            self.plot_unit_price_yocto.0 > 0,
            "plot unit price must be positive"
        );
        self.clone().into_legacy().validate();
    }

    pub fn from_legacy(legacy: GameConfig) -> Self {
        let GameConfig {
            version,
            coin_scale,
            starter_coins,
            base_rate_per_hour,
            tier_multiplier_bps,
            illegal_multiplier_bps,
            tower_multiplier_bps,
            earn_cap_seconds,
            expiry_grace_seconds,
            park_durability_cost,
            max_durability,
            max_cars,
            account_storage_bytes,
            plot_storage_bytes,
            repair_cost_per_point,
            buy_car_cost,
            tier_upgrade_costs,
            building_upgrade_costs,
            change_building_type_cost,
            meter_rate_max_per_hour,
            rule_delay_seconds,
            ticket_cooldown_seconds,
            ticket_recipient_bps,
            inspector_chance_bps,
            inspector_min_age_seconds,
            inspector_window_seconds,
            inspector_max_attempts_per_window,
            plot_base_price_yocto,
            corner_price_bps,
            tower_capacity,
            burger_decal_cost,
            logo_cooldown_seconds,
            facade_cooldown_seconds,
            emergency_repair_cooldown_seconds,
        } = legacy;
        require!(
            plot_base_price_yocto.0 > 0 && plot_base_price_yocto.0 % 2 == 0,
            "legacy two-unit price cannot become a unit price"
        );
        Self {
            version: version
                .checked_add(1)
                .unwrap_or_else(|| env::panic_str("config version overflow")),
            coin_scale,
            starter_coins,
            base_rate_per_hour,
            tier_multiplier_bps,
            illegal_multiplier_bps,
            tower_multiplier_bps,
            earn_cap_seconds,
            expiry_grace_seconds,
            park_durability_cost,
            max_durability,
            max_cars,
            account_storage_bytes,
            plot_storage_bytes,
            repair_cost_per_point,
            buy_car_cost,
            tier_upgrade_costs,
            building_upgrade_costs,
            change_building_type_cost,
            meter_rate_max_per_hour,
            rule_delay_seconds,
            ticket_cooldown_seconds,
            ticket_recipient_bps,
            inspector_chance_bps,
            inspector_min_age_seconds,
            inspector_window_seconds,
            inspector_max_attempts_per_window,
            plot_unit_price_yocto: U128(plot_base_price_yocto.0 / 2),
            corner_price_bps,
            tower_capacity,
            burger_decal_cost,
            logo_cooldown_seconds,
            facade_cooldown_seconds,
            emergency_repair_cooldown_seconds,
        }
    }

    pub fn price_yocto(&self, plot: &PlotV2) -> u128 {
        plot_price_yocto(
            plot.frontage_units,
            plot.corner,
            self.plot_unit_price_yocto.0,
            self.corner_price_bps,
        )
    }

    /// Only safe before a version-2 player action or config edit. The
    /// migration-only contract has no such methods, so it can restore V1.
    pub fn into_legacy(self) -> GameConfig {
        require!(self.version > 0, "version-2 config version is invalid");
        let plot_base_price_yocto = self
            .plot_unit_price_yocto
            .0
            .checked_mul(2)
            .unwrap_or_else(|| env::panic_str("legacy plot price overflow"));
        GameConfig {
            version: self.version - 1,
            coin_scale: self.coin_scale,
            starter_coins: self.starter_coins,
            base_rate_per_hour: self.base_rate_per_hour,
            tier_multiplier_bps: self.tier_multiplier_bps,
            illegal_multiplier_bps: self.illegal_multiplier_bps,
            tower_multiplier_bps: self.tower_multiplier_bps,
            earn_cap_seconds: self.earn_cap_seconds,
            expiry_grace_seconds: self.expiry_grace_seconds,
            park_durability_cost: self.park_durability_cost,
            max_durability: self.max_durability,
            max_cars: self.max_cars,
            account_storage_bytes: self.account_storage_bytes,
            plot_storage_bytes: self.plot_storage_bytes,
            repair_cost_per_point: self.repair_cost_per_point,
            buy_car_cost: self.buy_car_cost,
            tier_upgrade_costs: self.tier_upgrade_costs,
            building_upgrade_costs: self.building_upgrade_costs,
            change_building_type_cost: self.change_building_type_cost,
            meter_rate_max_per_hour: self.meter_rate_max_per_hour,
            rule_delay_seconds: self.rule_delay_seconds,
            ticket_cooldown_seconds: self.ticket_cooldown_seconds,
            ticket_recipient_bps: self.ticket_recipient_bps,
            inspector_chance_bps: self.inspector_chance_bps,
            inspector_min_age_seconds: self.inspector_min_age_seconds,
            inspector_window_seconds: self.inspector_window_seconds,
            inspector_max_attempts_per_window: self.inspector_max_attempts_per_window,
            plot_base_price_yocto: U128(plot_base_price_yocto),
            corner_price_bps: self.corner_price_bps,
            tower_capacity: self.tower_capacity,
            burger_decal_cost: self.burger_decal_cost,
            logo_cooldown_seconds: self.logo_cooldown_seconds,
            facade_cooldown_seconds: self.facade_cooldown_seconds,
            emergency_repair_cooldown_seconds: self.emergency_repair_cooldown_seconds,
        }
    }
}

impl PlotSeedV2 {
    pub fn id(&self) -> String {
        format!(
            "plot-{}-{}-{}",
            self.road_id.as_str(),
            self.side.short(),
            self.index
        )
    }

    pub fn validate(&self) {
        require!(self.index < 10, "version-2 plot index must be 0 through 9");
        require!(
            (1..=3).contains(&self.frontage_units),
            "plot frontage must be 1 through 3 units"
        );
        require!(
            self.variant == 1 || self.variant == 2,
            "building variant must be 1 or 2"
        );
    }

    fn corner(&self) -> bool {
        self.index == 0 || self.index == 9
    }
}

impl PlotV2 {
    pub fn default_design_choice(road_id: RoadId, side: Side, index: u8) -> u8 {
        let road_order = match road_id {
            RoadId::Main => 0,
            RoadId::Market => 1,
            RoadId::River => 2,
            RoadId::Central => 3,
            RoadId::Harbor => 4,
        };
        let side_offset = if side == Side::South { 1 } else { 0 };
        ((u16::from(index) * 2 + road_order + side_offset) % 5) as u8
    }

    pub fn unowned(seed: &PlotSeedV2) -> Self {
        seed.validate();
        Self {
            id: seed.id(),
            road_id: seed.road_id,
            side: seed.side,
            index: seed.index,
            frontage_units: seed.frontage_units,
            design_choice: Self::default_design_choice(seed.road_id, seed.side, seed.index),
            corner: seed.corner(),
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
        }
    }

    pub fn relocate_owned(legacy: Plot, target: &PlotSeedV2) -> Self {
        target.validate();
        require!(legacy.owner.is_some(), "legacy deed is not owned");
        require!(
            legacy.road_id == target.road_id && legacy.side == target.side,
            "deed move must stay on the same street side"
        );
        require!(
            target.frontage_units == 2,
            "owned legacy deed requires two frontage units"
        );
        let Plot {
            id: _,
            road_id: _,
            side: _,
            index: _,
            corner: _,
            owner,
            rule,
            pending_rule,
            building,
            logo,
            billboard,
            ticket_cooldown_until,
            reserved_storage_bytes,
            used_storage_bytes,
        } = legacy;
        Self {
            id: target.id(),
            road_id: target.road_id,
            side: target.side,
            index: target.index,
            frontage_units: target.frontage_units,
            design_choice: Self::default_design_choice(target.road_id, target.side, target.index),
            corner: target.corner(),
            owner,
            rule,
            pending_rule,
            building,
            logo,
            billboard,
            ticket_cooldown_until,
            reserved_storage_bytes,
            used_storage_bytes,
        }
    }

    pub fn effective_rule(&self, now: u64) -> ParkingRule {
        match &self.pending_rule {
            Some(pending) if now >= pending.effective_at => pending.rule.clone(),
            _ => self.rule.clone(),
        }
    }

    pub fn promote_pending(&mut self, now: u64) {
        if let Some(pending) = &self.pending_rule {
            if now >= pending.effective_at {
                self.rule = pending.rule.clone();
                self.pending_rule = None;
            }
        }
    }

    pub fn check_slot(&self, slot: u8) {
        require!(
            slot < self.frontage_units,
            "curb slot is outside plot frontage"
        );
    }

    pub fn billboard_supported(&self) -> bool {
        self.frontage_units == 2
            && (self.design_choice == 1 || self.design_choice == 4)
            && self.building.level >= 3
    }
}

pub fn plot_price_yocto(
    frontage_units: u8,
    corner: bool,
    unit_price_yocto: u128,
    corner_price_bps: u16,
) -> u128 {
    require!(
        (1..=3).contains(&frontage_units),
        "plot frontage must be 1 through 3 units"
    );
    require!(unit_price_yocto > 0, "plot unit price must be positive");
    require!(
        (10_000..=50_000).contains(&corner_price_bps),
        "corner price multiplier is out of bounds"
    );
    let base = unit_price_yocto
        .checked_mul(u128::from(frontage_units))
        .unwrap_or_else(|| env::panic_str("plot unit price overflow"));
    if !corner {
        return base;
    }
    base.checked_mul(u128::from(corner_price_bps))
        .unwrap_or_else(|| env::panic_str("corner plot price overflow"))
        / 10_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{MediaApproval, MediaIdentity};
    use near_sdk::{borsh, json_types::U128, serde_json};

    fn seed(units: u8, index: u8) -> PlotSeedV2 {
        PlotSeedV2 {
            road_id: RoadId::Main,
            side: Side::North,
            index,
            frontage_units: units,
            building_type: BuildingType::Retail,
            variant: 1,
        }
    }

    #[test]
    fn target_plots_have_one_to_three_real_slots() {
        for units in 1..=3 {
            let plot = PlotV2::unowned(&seed(units, 4));
            for slot in 0..units {
                plot.check_slot(slot);
            }
            assert!(std::panic::catch_unwind(|| plot.check_slot(units)).is_err());
        }
        assert!(std::panic::catch_unwind(|| PlotV2::unowned(&seed(0, 4))).is_err());
        assert!(std::panic::catch_unwind(|| PlotV2::unowned(&seed(4, 4))).is_err());
    }

    #[test]
    fn billboard_visibility_needs_a_supported_design_and_level() {
        let mut plot = PlotV2::unowned(&seed(2, 3));
        plot.design_choice = 1;
        plot.building.level = 2;
        assert!(!plot.billboard_supported());
        plot.building.level = 3;
        assert!(plot.billboard_supported());
        plot.design_choice = 4;
        assert!(plot.billboard_supported());
        plot.design_choice = 0;
        assert!(!plot.billboard_supported());
        plot.frontage_units = 3;
        plot.design_choice = 1;
        assert!(!plot.billboard_supported());
    }

    #[test]
    fn variable_frontage_does_not_preallocate_curb_slots_in_plot_storage() {
        let sizes: Vec<usize> = (1..=3)
            .map(|units| {
                borsh::to_vec(&PlotV2::unowned(&seed(units, 4)))
                    .expect("version-2 plot serializes")
                    .len()
            })
            .collect();
        assert_eq!(sizes[0], sizes[1]);
        assert_eq!(sizes[1], sizes[2]);
        let mut old_value = serde_json::to_value(PlotV2::unowned(&seed(2, 4))).expect("plot JSON");
        let old_object = old_value.as_object_mut().expect("plot object");
        old_object.remove("frontage_units");
        old_object.remove("design_choice");
        let old: Plot = serde_json::from_value(old_value).expect("legacy plot JSON");
        let legacy_bytes = borsh::to_vec(&old).expect("legacy plot serializes").len();
        assert_eq!(sizes[1], legacy_bytes + 2);
        eprintln!(
            "serialized plot bytes: legacy={legacy_bytes}, version-2={}; frontage 1/2/3={sizes:?}",
            sizes[1]
        );
    }

    #[test]
    fn initial_design_uses_the_guest_city_order() {
        let main_north: Vec<u8> = (0..10)
            .map(|index| PlotV2::unowned(&seed(2, index)).design_choice)
            .collect();
        assert_eq!(main_north, vec![0, 2, 4, 1, 3, 0, 2, 4, 1, 3]);
        assert_eq!(
            PlotV2::default_design_choice(RoadId::Market, Side::South, 0),
            2
        );
    }

    #[test]
    fn owned_deed_move_preserves_every_non_location_field() {
        let target = seed(2, 3);
        let mut original = PlotV2::unowned(&seed(2, 2));
        original.owner = Some("owner.testnet".parse().expect("valid account"));
        original.rule = ParkingRule::Meter {
            rate_per_hour: U128(9_000_000),
        };
        original.pending_rule = Some(PendingRule {
            rule: ParkingRule::NoParking,
            effective_at: 1_200,
        });
        original.building.level = 3;
        original.building.approved_manifest_hash = Some("b".repeat(64));
        original.logo.active = Some(MediaApproval {
            content: MediaIdentity {
                asset_hash: "a".repeat(64),
                link: Some("https://near.org".to_string()),
            },
            approved_layout_revision: 4,
            approved_at: 900,
        });
        original.ticket_cooldown_until = 1_400;
        original.reserved_storage_bytes = 4_096;
        original.used_storage_bytes = 3_200;
        let legacy: Plot = serde_json::from_value({
            let mut value = serde_json::to_value(&original).expect("serialize plot");
            value
                .as_object_mut()
                .expect("plot object")
                .remove("frontage_units");
            value
                .as_object_mut()
                .expect("plot object")
                .remove("design_choice");
            value
        })
        .expect("legacy plot");
        let moved = PlotV2::relocate_owned(legacy.clone(), &target);
        let mut expected = serde_json::to_value(&legacy).expect("serialize legacy plot");
        let object = expected.as_object_mut().expect("plot object");
        object.insert("id".to_string(), serde_json::json!(target.id()));
        object.insert("index".to_string(), serde_json::json!(target.index));
        object.insert("frontage_units".to_string(), serde_json::json!(2));
        object.insert(
            "design_choice".to_string(),
            serde_json::json!(PlotV2::default_design_choice(
                target.road_id,
                target.side,
                target.index
            )),
        );
        assert_eq!(
            serde_json::to_value(&moved).expect("serialize moved plot"),
            expected
        );
        assert!(matches!(
            moved.effective_rule(1_100),
            ParkingRule::Meter { .. }
        ));
        assert!(matches!(
            moved.effective_rule(1_200),
            ParkingRule::NoParking
        ));
        assert_eq!(moved.owner, original.owner);
    }

    #[test]
    fn version_two_price_uses_units_and_corner_multiplier() {
        const HALF_NEAR: u128 = 500_000_000_000_000_000_000_000;
        assert_eq!(plot_price_yocto(1, false, HALF_NEAR, 20_000), HALF_NEAR);
        assert_eq!(
            plot_price_yocto(2, false, HALF_NEAR, 20_000),
            1_000_000_000_000_000_000_000_000
        );
        assert_eq!(
            plot_price_yocto(3, false, HALF_NEAR, 20_000),
            1_500_000_000_000_000_000_000_000
        );
        assert_eq!(
            plot_price_yocto(3, true, HALF_NEAR, 20_000),
            3_000_000_000_000_000_000_000_000
        );
        assert!(std::panic::catch_unwind(|| plot_price_yocto(3, true, u128::MAX, 20_000)).is_err());
    }

    #[test]
    fn config_conversion_preserves_other_rules_and_prices_two_units_equally() {
        let old = GameConfig::default();
        let converted = GameConfigV2::from_legacy(old.clone());
        let mut expected = serde_json::to_value(&old).expect("legacy config JSON");
        let fields = expected.as_object_mut().expect("config object");
        fields.insert("version".to_string(), serde_json::json!(old.version + 1));
        fields.remove("plot_base_price_yocto");
        fields.insert(
            "plot_unit_price_yocto".to_string(),
            serde_json::json!("500000000000000000000000"),
        );
        assert_eq!(
            serde_json::to_value(&converted).expect("version-2 config JSON"),
            expected
        );
        assert_eq!(
            converted.price_yocto(&PlotV2::unowned(&seed(2, 4))),
            old.plot_base_price_yocto.0
        );
        assert_eq!(
            near_sdk::borsh::to_vec(&converted.into_legacy()).expect("restored config"),
            near_sdk::borsh::to_vec(&old).expect("original config")
        );
    }
}
