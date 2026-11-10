import assert from "node:assert/strict";
import test from "node:test";
import type { ChainMediaSlot } from "@estate/shared";
import { visibleMediaHash, visibleMediaLink } from "./media-view.js";

const hash = "a".repeat(64);
const approved: ChainMediaSlot = {
  revision: 3,
  active: {
    content: { asset_hash: hash, link: "https://brand.example" },
    approved_layout_revision: 4,
    approved_at: 100,
  },
  pending: null,
  last_decision: null,
  last_replacement_at: 100,
};

test("street media requires both chain eligibility and the current building layout", () => {
  assert.equal(visibleMediaHash(approved, true, 4), hash);
  assert.equal(visibleMediaHash(approved, false, 4), undefined);
  assert.equal(visibleMediaHash(approved, true, 5), undefined);
  assert.equal(
    visibleMediaHash({ ...approved, active: null }, true, 4),
    undefined,
  );
});

test("driver link follows exact approved media and only opens HTTPS", () => {
  assert.equal(visibleMediaLink(approved, true, 4), "https://brand.example/");
  assert.equal(visibleMediaLink(approved, false, 4), undefined);
  assert.equal(visibleMediaLink(approved, true, 5), undefined);
  assert.equal(
    visibleMediaLink(
      {
        ...approved,
        pending: {
          revision: 4,
          owner: "owner.testnet",
          building_type: "Retail",
          level: 2,
          layout_revision: 4,
          content: {
            asset_hash: "b".repeat(64),
            link: "https://pending.example",
          },
        },
      },
      true,
      4,
    ),
    "https://brand.example/",
  );
  assert.equal(
    visibleMediaLink(
      {
        ...approved,
        active: {
          ...approved.active!,
          content: { asset_hash: hash, link: "javascript:alert(1)" },
        },
      },
      true,
      4,
    ),
    undefined,
  );
});
