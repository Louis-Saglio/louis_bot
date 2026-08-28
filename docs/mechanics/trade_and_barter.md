# Trade and barter (0 A.D. 0.28.0)

This file documents the two resource-conversion mechanics: **barter** (instant exchange of resources at a market, prices drift with use) and **trade routes** (trader units shuttling between markets/docks generating resources per trip). Grounded in:

- `public/simulation/components/Barter.js` — barter system component
- `public/simulation/components/Trader.js` — trader unit component
- `public/simulation/components/Market.js` — market/dock component and gain computation
- `public/simulation/components/Player.js` — barter multipliers, trading goods
- `public/globalscripts/Trade.js` — the distance-based gain formula
- `public/globalscripts/Resources.js` + `public/simulation/data/resources/*.json` — resource properties and true prices
- `public/simulation/templates/template_structure_economic_market.xml`, `template_structure_military_dock.xml`, `template_unit_support_trader.xml`, `template_unit_ship_merchant.xml`, `template_player.xml`
- `public/simulation/components/UnitAI.js` — the trade order state machine
- `public/simulation/helpers/Commands.js` — the commands a player/AI issues

All paths above are relative to `/home/ubuntu/0ad-reference`. The four resources food, wood, stone, metal are all `barterable`, `tradable` and `tributable`, and all have `truePrice: 100` (`public/simulation/data/resources/*.json`) — so in 0.28.0 all resources barter at equal base value.

## Barter

`Barter` is a **system component**: there is one global instance, and its price state (`priceDifferences`) is **shared by all players** (`Barter.js:43-48`). One player's deals move the prices every player sees.

### Requirement

A player can barter only while they own at least one completed (non-foundation) entity with the `Barter` class (`Player.js:187-190`, `Player.js:639-640`). In the standard templates only the market carries that class (`template_structure_economic_market.xml:27`); docks do not.

### Prices

Per resource, with global dynamic offset `d` (`priceDifferences`, starts at 0) and per-player multipliers `mb`/`ms` (default 1.0 for all resources, `template_player.xml:68-81`, modifiable via `Player/BarterMultiplier/Buy|Sell/<res>`, `Player.js:652-657`):

```
buy  = truePrice × (100 + 10 + d) × mb / 100     (Barter.js:57)
sell = truePrice × (100 − 10 + d) × ms / 100     (Barter.js:58)
```

The constant `±10` (`CONSTANT_DIFFERENCE`, `Barter.js:26`) is the spread: at `d = 0`, multipliers 1.0, selling 100 of a resource buys `round(100 × 90/110) = 82` of another equal-price resource.

### Executing an exchange

Command `"barter"` with `{sell, buy, amount}` (`Commands.js:680-684` → `Barter.ExchangeResources`, `Barter.js:63`):

- `amount` must be exactly `100` (`DEAL_AMOUNT`) or `500` (`BATCH_SIZE × DEAL_AMOUNT = 5×100`); anything else is silently rejected (`Barter.js:83-84`).
- The sold resource is subtracted first; if the player lacks it, the deal is cancelled (`Barter.js:90-94`).
- Received amount: `round(sell[sold] / buy[bought] × amount)` (`Barter.js:96-98`). The exchange rate therefore depends on **both** resources' current dynamic offsets.

### Price drift and recovery

After each deal, with `diff = 2 × amountReceived / 100` (`DIFFERENCE_PER_DEAL = 2`, `Barter.js:31,116`):

```
d[sold]   −= diff     (selling makes the resource cheaper)
d[bought] += diff     (buying makes it more expensive)
```

`d` is clamped so the total (constant + dynamic) stays within ±99 %: `d ∈ [−89, 89]` (`Barter.js:117-124`). Every 5 s (`RESTORE_TIMER_INTERVAL = 5000`) each offset moves `0.5` (`DIFFERENCE_RESTORE`) back toward 0; the restore timer stops once all offsets are 0 (`Barter.js:130-147`). Repeated one-way bartering is therefore increasingly expensive, and prices fully recover given time.

## Trade routes

### Entities

| Entity | Template | Key trade data |
|---|---|---|
| Market | `template_structure_economic_market.xml` | `TradeType: land`, `InternationalBonus: 0.2` (lines 37-40); requires `phase_town`; trains `units/{civ}/support_trader` |
| Dock | `template_structure_military_dock.xml` | `TradeType: land naval` — serves **both** land traders and ships (lines 33-36); `InternationalBonus: 0.2`; trains `units/{civ}/ship_merchant` |
| Trader (land) | `template_unit_support_trader.xml` | `GainMultiplier: 0.75` (line 43); 100 food + 80 metal, 15 s |
| Merchantman (ship) | `template_unit_ship_merchant.xml` | `GainMultiplier: 0.75`, `GarrisonGainMultiplier: 0.2` (lines 37-40); 100 metal, 20 s; requires `phase_town`; garrison capacity 15 |

`GainMultiplier` is modifiable by technologies via `Trader/GainMultiplier` (`Trader.js:151-154`): `trade_gain_01` and `trade_gain_02` each multiply it by 1.15 (`public/simulation/data/technologies/trade_gain_01.json`, `trade_gain_02.json`).

### Route setup and eligibility

A route is two markets; a trader shuttles between them. Setup via command `"setup-trade-route" {target, source, route, queued}` (`Commands.js:661-666` → `UnitAI.SetupTradeRoute`, `UnitAI.js:5793`) or progressively via `Trader.SetTargetMarket` (`Trader.js:88-139`). Issuing a new target when two markets are already set drops the whole route and starts a new one (`Trader.js:102-115`).

`Trader.CanTrade` (`Trader.js:168-187`) requires the target to:

- have a `Market` component and not be a foundation;
- match the trader's medium: `Organic` traders need a market with type `land`, `Ship` traders need type `naval` (docks have both, markets only `land`);
- not be owned by an **enemy** — own, allied and neutral markets are all valid.

Trading with allied markets hidden by fog of war works through the market's mirage: traders are switched between market and mirage as visibility changes (`Market.js:151-209`, `Trader.js:266-275`).

### Gain formula (exact)

Computed per leg by `Market.CalculateTraderGain` (`Market.js:77-139`) using the **straight-line Euclidean distance** between the two markets' 2D positions — the pathfinder is deliberately not used (`Market.js:115-117`). With `S = mapSize` in **metres** (`IID_Terrain.GetMapSize()` = tiles per side × 4, `source/source/simulation2/components/CCmpTerrain.cpp:113-116`, `source/source/graphics/Terrain.h:41` — e.g. a 128-tile map gives `S = 512`):

```
TradeGain(d², S)      = d² / (1 + 0.25 × d / S)                                   (Trade.js:12-15)
Normalization(S)      = sqrt(1024 / S) / TradeGain(100², S)                       (Trade.js:4-7)
traderGain            = round(GainMultiplier × Normalization(S) × TradeGain(d², S))  (Market.js:96-120)
```

`GainMultiplier` (0.75 for both trader types) is the per-leg gain for a 100 m route on a 1024 m map (`Trader.js:12`). The gain grows **faster than linearly** with distance (roughly quadratic for `d ≪ S`) — long routes are strongly favoured.

Worked examples, `GainMultiplier = 0.75`, `S = 512` (128-tile map, the harness setting):

- `d = 100 m` → `round(0.75 × 1.4833e-4 × 9534.4)` = **1**
- `d = 200 m` → **4**; `d = 400 m` → **15**

**Edge case:** if `traderGain` rounds to 0, the UnitAI trade order aborts (`UnitAI.js:3036-3041`) — extremely short routes silently stall the trader.

### Gain distribution and international trade

Each arrival pays out (`Trader.PerformTrade` → `GenerateResources`, `Trader.js:200-234`):

- `traderGain` — to the **trader's owner**, in the resource chosen for that leg (see below);
- if the two markets have **different owners**, each market's owner additionally receives `round(traderGain × InternationalBonus)` of their own market (`Market.js:130-136`). `InternationalBonus` is 0.2 on both markets and docks, modifiable via `Market/InternationalBonus`: `trade_commercial_treaty` adds +0.1, `silk_road` (han) multiplies by 1.2. This bonus exists only when the market owners differ; both markets' owners get it, using their own market's bonus value.

The resource type gained on a leg is drawn **at each departure** from the player's trading-goods probability distribution: `Player.GetNextTradingGoods` (`Player.js:364-376`), called in `PerformTrade` (`Trader.js:230`). Default distribution: 25/25/25/25 over food/wood/stone/metal (`Player.js:88-96`). A bot sets it with the `"set-trading-goods"` command — a `{resource: percentage}` object that must only use tradable codes and sum to exactly 100, else it is rejected with an error and the old distribution is kept (`Player.js:387-413`, `Commands.js:675-678`). The percentages are per-trip draw probabilities, not a fixed cycle: every leg independently rolls the resource.

### Trader behavior per trip (UnitAI)

The `Trade` order (`UnitAI.js:3020-3058`) loops forever: approach market within trade range (`max = 1 + 1.5 × obstructionSize`, `Trader.js:294-301`), then `PerformTrade` which (1) pays the gain for the leg just completed, (2) draws the next leg's resource, (3) precomputes the next leg's gain, (4) returns the other market as the new target. The `route` waypoint list (used for naval paths) is reversed when heading back (`UnitAI.js:3045-3050`).

If a market is destroyed or becomes invalid (ownership/diplomacy change), `Market.UpdateTraders` removes its traders (`Market.js:59-75`); the trader drops that market and walks to its remaining one or stops (`UnitAI.js:3060-3069`, `Trader.js:252-261`). Any route change discards carried (unpaid) goods (`Trader.js:136-138`).

### Naval trade and garrison bonus

Naval trade uses the same mechanics: merchant ships trade between docks (or any market with `TradeType naval`; in the standard templates only docks). The Merchantman has `GarrisonGainMultiplier: 0.2`: each garrisoned entity with a `Trader` component multiplies all three gains by `1 + 0.2 × count` (`Trader.js:38-65`; capacity 15, `template_unit_ship_merchant.xml:9-12`). The multiplier is recomputed whenever garrisoned units change (`Trader.js:303-307`).
