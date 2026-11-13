use near_sdk::{json_types::U128, near, AccountId};

use crate::CarColor;

#[near(serializers = [borsh, json])]
#[serde(rename_all = "lowercase")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RoadId {
    Main,
    Market,
    River,
    Central,
    Harbor,
}

impl RoadId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Market => "market",
            Self::River => "river",
            Self::Central => "central",
            Self::Harbor => "harbor",
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Side {
    North,
    South,
}

impl Side {
    pub fn short(self) -> &'static str {
        if self == Self::North {
            "n"
        } else {
            "s"
        }
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BuildingType {
    Retail,
    Cafe,
    Restaurant,
    Office,
    Homes,
}

#[near(serializers = [borsh, json])]
#[serde(tag = "kind")]
#[derive(Clone, PartialEq, Eq)]
pub enum ParkingRule {
    Free,
    Meter {
        #[serde(rename = "ratePerHour")]
        rate_per_hour: U128,
    },
    ColorOnly {
        color: CarColor,
    },
    NoParking,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PendingRule {
    pub rule: ParkingRule,
    pub effective_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct BuildingState {
    pub building_type: BuildingType,
    pub variant: u8,
    pub level: u8,
    pub primary_color: String,
    pub name: String,
    pub approved_manifest_hash: Option<String>,
    pub approved_at: Option<u64>,
    pub last_facade_approved_at: Option<u64>,
    pub pending_appearance: Option<AppearanceReference>,
    pub last_appearance_decision: Option<AppearanceDecision>,
    pub facade_exemption_level: Option<u8>,
    pub appearance_revision: u64,
    pub layout_revision: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Logo,
    Billboard,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
pub struct MediaIdentity {
    pub asset_hash: String,
    pub link: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
pub struct MediaProposal {
    pub revision: u64,
    pub owner: AccountId,
    pub building_type: BuildingType,
    pub level: u8,
    pub layout_revision: u64,
    pub content: MediaIdentity,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct MediaApproval {
    pub content: MediaIdentity,
    pub approved_layout_revision: u64,
    pub approved_at: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MediaDecisionStatus {
    Approved,
    Rejected,
    Revoked,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct MediaDecision {
    pub proposal: MediaProposal,
    pub status: MediaDecisionStatus,
    pub decided_at: u64,
    pub reason: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Default)]
pub struct MediaSlot {
    pub revision: u64,
    pub active: Option<MediaApproval>,
    pub pending: Option<MediaProposal>,
    pub last_decision: Option<MediaDecision>,
    pub last_replacement_at: Option<u64>,
}

impl MediaSlot {
    pub fn eligible(&self, layout_revision: u64) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.approved_layout_revision == layout_revision)
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
pub struct AppearanceReference {
    pub revision: u64,
    pub owner: AccountId,
    pub building_type: BuildingType,
    pub level: u8,
    pub manifest_hash: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum AppearanceStatus {
    Approved,
    Rejected,
    Revoked,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct AppearanceDecision {
    pub reference: AppearanceReference,
    pub status: AppearanceStatus,
    pub decided_at: u64,
    pub reason: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Plot {
    pub id: String,
    pub road_id: RoadId,
    pub side: Side,
    pub index: u8,
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

impl Plot {
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
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PlotSeed {
    pub road_id: RoadId,
    pub side: Side,
    pub index: u8,
    pub building_type: BuildingType,
    pub variant: u8,
}

impl PlotSeed {
    pub fn id(&self) -> String {
        format!(
            "plot-{}-{}-{}",
            self.road_id.as_str(),
            self.side.short(),
            self.index
        )
    }
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PlotView {
    pub plot: Plot,
    pub effective_rule: ParkingRule,
    pub logo_eligible: bool,
    pub billboard_eligible: bool,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct PlotPurchaseBreakdown {
    pub price_yocto: U128,
    pub storage_reserve_yocto: U128,
    pub total_yocto: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ServiceRole {
    ParkingTower,
    RepairGarage,
    Cinema,
    BurgerStop,
    PracticeCourse,
    HorseCourse,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct NPCSiteSeed {
    pub id: String,
    pub road_id: RoadId,
    pub side: Side,
    pub frontage_index: u8,
    pub role: ServiceRole,
    pub name: String,
    pub capacity: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
pub struct NPCSite {
    pub id: String,
    pub road_id: RoadId,
    pub side: Side,
    pub frontage_index: u8,
    pub role: ServiceRole,
    pub name: String,
    pub capacity: u8,
}
