# ⚡ PowerTracker

A self-contained web app for tracking **prepaid electricity** (EDM Credelec / M-Pesa style),
predicting when you'll run out, and monitoring where your kWh go.

No server, no accounts, no dependencies. All data lives in your browser (`localStorage`).
Works offline and installs to your phone's home screen as a PWA.

---

## What it does

- **Daily meter readings** — enter the *remaining kWh* shown on your prepaid meter (it counts down).
- **Predictions** — from the gap between readings it computes your average kWh/day, an estimate of
  how much is left *right now*, days remaining, and the date the meter will hit zero.
- **Recharge alerts** — warns you (banner + optional browser notification) when the balance drops
  below a kWh or days-remaining threshold you set.
- **Recharges** — log each top-up (MT paid + kWh received); it derives the rate (MT/kWh) and adds
  the energy to your balance so predictions stay accurate across recharges.
- **Appliances** — pre-loaded with your setup (server + gaming PC, geyser, fridges, pumps, etc.).
  See each one's daily kWh and share of the total, and compare the *modeled* total against your
  *measured* usage.
- **Backup** — export/import all data as JSON.

## The core idea

Your meter shows **remaining kWh** and counts down. Between two readings:

```
consumed = previous_reading + recharges_in_between − current_reading
kWh/day  = consumed ÷ days_between
```

Enter a reading once or twice a day at roughly the same time for the cleanest trend.

## How to use it

1. **Open `index.html`** — double-click it, or host the folder (see below).
2. Each day, go to **Log → Log meter reading**, type the number on your meter, save.
3. When you top up, go to **Log → Log recharge**, enter MT paid and kWh received.
4. The **Home** tab shows days remaining, estimated balance, cost/day, and charts.
5. In **Settings**, set your alert thresholds and (optionally) enable browser notifications.

> First launch is pre-seeded with the recharge from your receipt (2000 MT → 238.2 kWh) so there's
> something to look at. Delete or edit it anytime from the **Log → History** list.

## Hosting (optional, recommended for phone use + notifications)

Browser notifications and "Add to Home Screen" work best over `https`. Easiest free option:

**GitHub Pages**
1. Push this folder to a GitHub repo.
2. Repo → **Settings → Pages** → Source: `main` branch, `/root`.
3. Open the published URL on your phone → browser menu → **Add to Home Screen**.

Locally you can also run any static server, e.g.:

```bash
python -m http.server 8080
```

then open `http://localhost:8080`.

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell & layout |
| `styles.css` | Theme (dark, mobile-first, light-mode aware) |
| `app.js` | State, calculation engine, charts, UI |
| `manifest.json` / `sw.js` | PWA install + offline cache |

## Notes

- Data is stored **only on the device/browser you use**. Use **Settings → Export** to keep a backup,
  and Import to move it to another device.
- The appliance figures are editable estimates to help you find savings — tune the watts and
  hours to match reality. "Hours/day" means *effective ON time* (a fridge compressor or geyser
  thermostat only runs part of the day).
