---
description: "Research-grounded context notes for finance prompt drafting"
argument-hint: "required prompt type"
---
## Source-Derived Context Pack

### Macro + Market Regime Inputs
- Macro regime transitions are usually framed around growth, inflation, liquidity, and policy expectations; confidence should be probabilistic (base / base- / base+) not absolute.
- Multiple sources emphasize short-rate and yield-curve behavior as primary transmission channels for equities (Fed minutes, inflation surprises, labor data).
- Regulatory references used for intraday prompts:
  - pattern day trader threshold (>=4 day trades in 5 trading days)
  - 25,000 USD minimum equity for margin trading under pattern day trading rules

### Sector/Industry Framework Inputs
- Porter-like competitive structure remains a practical baseline for sector filters:
  - rivalry intensity
  - entry barriers
  - customer and supplier power
  - substitution risk
- Sector rotation logic should be tied to relative performance and breadth rather than pure thematic preference.

### Stock/Valuation Inputs
- Fundamental assessment should include demand quality, pricing power, margin trajectory, and balance-sheet resilience.
- Intrinsic value workflows often use DCF/relative valuation and margin-of-safety framing; this should stay as scenario banding, not a single-point prediction.
- Moat/competitive advantage can be captured as qualitative durability and decay risk.

### Trading Horizon Inputs
- Position/swing/intraday distinctions:
  - short-term (weeks)
  - swing (multi-day to few weeks)
  - intraday (same-session)
- RSI, MACD, and support/resistance are confirmed as commonly used technical confirmation tools; use cross-confirmation rather than single-indicator signals.
- Intraday prompts must apply spread/liquidity checks plus PDT/compliance checks.

### Allocation/Portfolio Inputs
- Core risk principles consistently seen in finance literature:
  - diversification across asset classes/sectors
  - time horizon and risk tolerance driven asset mix
  - explicit rebalance and stop/cut logic
- Portfolio prompt should normalize signal conflicts and enforce hard concentration ceilings.

## Constraint Notes

- No deterministic promises.
- Always return confidence, scenario labels, and invalidation conditions.
- Add `No-Trade Zone` outputs when structure conflicts or data sufficiency is low.

