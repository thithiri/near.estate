use near_estate_contract::{NPCSite, RoadId, ServiceRole, Side};
use near_sdk::{env, near, require};

use crate::{Contract, ContractExt};

const MOVES: [(&str, RoadId, Side, ServiceRole, u8, u8); 7] = [
    (
        "npc-main-tower",
        RoadId::Main,
        Side::North,
        ServiceRole::ParkingTower,
        8,
        10,
    ),
    (
        "npc-market-tower",
        RoadId::Market,
        Side::South,
        ServiceRole::ParkingTower,
        8,
        10,
    ),
    (
        "npc-river-tower",
        RoadId::River,
        Side::North,
        ServiceRole::ParkingTower,
        8,
        10,
    ),
    (
        "npc-central-garage",
        RoadId::Central,
        Side::North,
        ServiceRole::RepairGarage,
        8,
        10,
    ),
    (
        "npc-harbor-cinema",
        RoadId::Harbor,
        Side::North,
        ServiceRole::Cinema,
        8,
        10,
    ),
    (
        "npc-market-burgers",
        RoadId::Market,
        Side::North,
        ServiceRole::BurgerStop,
        9,
        11,
    ),
    (
        "npc-central-course",
        RoadId::Central,
        Side::South,
        ServiceRole::PracticeCourse,
        9,
        11,
    ),
];

#[near]
impl Contract {
    pub fn repair_npc_frontages(&mut self) -> Vec<NPCSite> {
        require!(
            env::predecessor_account_id() == self.inner.admin,
            "admin only"
        );
        require!(self.inner.paused, "pause the city before repair");
        require!(
            self.inner.city_version == 2
                && self.inner.plot_count == 100
                && self.inner.npc_site_count == 7,
            "unexpected city layout"
        );
        let mut updated = Vec::with_capacity(MOVES.len());
        for (id, road, side, role, old_index, new_index) in MOVES {
            let mut site = self
                .inner
                .npc_sites
                .get(&id.to_string())
                .cloned()
                .unwrap_or_else(|| env::panic_str("repair civic site missing"));
            require!(
                site.id == id
                    && site.road_id == road
                    && site.side == side
                    && site.role == role
                    && site.frontage_index == old_index,
                "civic site differs from frozen repair input"
            );
            if role == ServiceRole::ParkingTower {
                for slot in 0..site.capacity {
                    require!(
                        self.inner
                            .space_sessions
                            .get(&format!("t:{id}:{slot}"))
                            .is_none(),
                        "clear tower parking before repair"
                    );
                }
            }
            site.frontage_index = new_index;
            self.inner.npc_sites.insert(id.to_string(), site.clone());
            updated.push(site);
        }
        self.inner.npc_sites.flush();
        updated
    }
}
