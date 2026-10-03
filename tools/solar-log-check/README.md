# solar-log-check

Analyzes the solar log njsPC writes when `log.solar.logToFile` is on (`logs/solarLog(<time>).log`).
One standard-library Python 3.8+ file, no install.

```bash
python3 tools/solar-log-check/solar_log_check.py                       # the newest solar log
python3 tools/solar-log-check/solar_log_check.py 2026-10-03_12-32-48   # a log, by part of its name
python3 tools/solar-log-check/solar_log_check.py /path/to/other.log    # or by path
python3 tools/solar-log-check/solar_log_check.py --list                # the solar logs found
python3 tools/solar-log-check/solar_log_check.py --timeline            # also list every run and off period
python3 tools/solar-log-check/solar_log_check.py --since 13:00         # only lines from 13:00 on
```

It looks for the logs in `<njsPC>/logs` (or `./logs`, or `--logs-dir`, or `$NJSPC_LOGS`).

For the most from it, turn on `log.solar.explain` in `config.json`. Without it the log has the decisions
and the switching but not the reasons solar stayed off or what the settle delays held.

## What it reports

- **Runs:** when solar was on, for how long, the water and collector readings at each change, runs shorter than
  5 minutes, and why each run stopped (the water reached its target, or the collector's lead fell to the run delta).
- **Off periods:** how long solar was held off, split by the reason the log gave (at target, collector not
  warmer than the water, lead under the run delta, reheat guard, and the nocturnal cooling reasons). It
  calls out time the reheat guard kept solar off while the water was below the setpoint and the collector
  was at least 10 degrees above it.
- **Commands to the relay manager:** changes sent more than once in the same second.
- **Water temperature jumps:** a degree or more within 90 seconds, which is warm or cool water standing in
  the pipes reaching the sensor right after the pump starts or the valve moves.
- **Settle delays:** the delays that held a start, and the waits before a stop (`controller.solar.settleMinutes`, default 5): solar
  stops for the water only after it has stayed a hysteresis (`controller.solar.hysteresis`, default 1 degree) past the setpoint for the
  whole delay, and restarts a hysteresis back the other side.
- **Cycling:** three or more runs under 10 minutes, which the hysteresis is there to prevent.
