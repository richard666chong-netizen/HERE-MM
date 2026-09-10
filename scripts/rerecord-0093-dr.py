#!/usr/bin/env python3
"""Step4 Task4: DR 增强 0093 fixture 重录（一次性工具，入库留痕）。

逐条抄录 T2 钉死规则（帧 0 无条件播种 / 历元 i%10===0 / 更新门控 numsats>6 /
gain 0.3 / 同米制常数 M_PER_DEG_LAT=111320），对 public/sample/here/0093.json
生成 DR 增强请求 → curl live（key 经 .env 读入不回显）→ 对比原始（4 段/292m）：
section 数减少则替换 public/fixtures/2011_09_26_drive_0093.json（source 'mock'），
否则保留原始并在 stdout 记录实证。

同时把 DR positions（433 点 [lat,lng]）落盘为
public/sample/here/2011_09_26_drive_0093.dr.json（入库 artifact），
供 vitest 逐点 haversine ≤0.1m 比对——py 复刻参数漂移即红。
"""
import json
import math
import os
import sys
import urllib.request
import urllib.error

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

M_PER_DEG_LAT = 111320
R_EARTH_M = 6371008.8
DEG = math.pi / 180
GAIN = 0.3
UPDATE_THRESHOLD = 6


def yaw_to_compass_deg(yaw_deg):
    return ((90 - yaw_deg) % 360 + 360) % 360


def haversine_m(a_lat, a_lng, b_lat, b_lng):
    d_lat = (b_lat - a_lat) * DEG
    d_lng = (b_lng - a_lng) * DEG
    s = (math.sin(d_lat / 2) ** 2 +
         math.cos(a_lat * DEG) * math.cos(b_lat * DEG) * math.sin(d_lng / 2) ** 2)
    return 2 * R_EARTH_M * math.asin(math.sqrt(s))


def detect_outages(trace, sat_threshold=4):
    return [p['numsats'] <= sat_threshold for p in trace]


def dead_reckon(trace):
    """Replicate src/lib/deadReckoning.ts deadReckon() exactly."""
    n = len(trace)
    if n == 0:
        return [], [], []
    positions = []
    corrected = []
    innovations = []
    p_lat = trace[0]['lat']
    p_lng = trace[0]['lng']
    for k in range(n):
        if k > 0:
            dt = trace[k]['timestamp'] - trace[k - 1]['timestamp']
            c = yaw_to_compass_deg(trace[k]['headingDeg']) * DEG
            step = trace[k]['speedMps'] * dt
            p_lat = p_lat + (step * math.cos(c)) / M_PER_DEG_LAT
            p_lng = p_lng + (step * math.sin(c)) / (M_PER_DEG_LAT * math.cos(p_lat * DEG))
        if k % 10 == 0 and trace[k]['numsats'] > UPDATE_THRESHOLD:
            innovations.append(haversine_m(trace[k]['lat'], trace[k]['lng'], p_lat, p_lng))
            p_lat = p_lat + GAIN * (trace[k]['lat'] - p_lat)
            p_lng = p_lng + GAIN * (trace[k]['lng'] - p_lng)
            corrected.append(True)
        else:
            innovations.append(0)
            corrected.append(False)
        positions.append([p_lat, p_lng])
    return positions, corrected, innovations


def round6(v):
    return round(v * 1e6) / 1e6


def build_import_request(trace):
    """Replicate src/lib/hereRouterClient.ts buildImportRequest() exactly."""
    n = len(trace)
    stride = max(1, math.ceil(n / 500))
    out = []
    for i in range(0, n, stride):
        out.append({'lat': round6(trace[i]['lat']), 'lng': round6(trace[i]['lng'])})
    last = trace[n - 1]
    if (n - 1) % stride != 0:
        out.append({'lat': round6(last['lat']), 'lng': round6(last['lng'])})
    return out


def read_key():
    env_path = os.path.join(ROOT, '.env')
    with open(env_path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.strip().startswith('VITE_HERE_KEY='):
                val = line.strip()[len('VITE_HERE_KEY='):]
                if val:
                    return val
    raise RuntimeError('VITE_HERE_KEY missing in .env')


def main():
    drive_id = '2011_09_26_drive_0093'
    trace_path = os.path.join(ROOT, 'public', 'sample', 'here', f'{drive_id}.json')
    fixture_path = os.path.join(ROOT, 'public', 'fixtures', f'{drive_id}.json')
    artifact_path = os.path.join(ROOT, 'public', 'sample', 'here', f'{drive_id}.dr.json')

    with open(trace_path, 'r') as f:
        trace = json.load(f)

    # --- DR computation (replicate TS deadReckon) ---
    positions, corrected, innovations = dead_reckon(trace)

    # --- Save artifact (DR positions for vitest cross-check) ---
    with open(artifact_path, 'w') as f:
        json.dump(positions, f)
    print(f'artifact saved: {artifact_path} ({len(positions)} points)')

    # --- Build DR-augmented trace for import request ---
    dr_trace = []
    for i, p in enumerate(trace):
        dr_trace.append({
            'lat': positions[i][0],
            'lng': positions[i][1],
            'timestamp': p['timestamp'],
            'timestampUtc': p['timestampUtc'],
            'headingDeg': p['headingDeg'],
            'speedMps': p['speedMps'],
            'numsats': p['numsats'],
        })

    req_points = build_import_request(dr_trace)
    body = json.dumps({'trace': req_points}).encode('utf-8')

    # --- Read original fixture for comparison ---
    with open(fixture_path, 'r') as f:
        orig_fixture = json.load(f)
    orig_sections = orig_fixture['response']['routes'][0]['sections']
    orig_section_count = len(orig_sections)
    orig_total_len = sum(s['summary']['length'] for s in orig_sections)
    print(f'original: {orig_section_count} sections, {orig_total_len} m')

    # --- Call HERE API live ---
    try:
        key = read_key()
    except RuntimeError as e:
        print(f'WARNING: {e} — skipping live API call. Artifact still saved.')
        return

    url = (f'https://router.hereapi.com/v8/import'
           f'?return=polyline,summary&transportMode=car&apikey={key}')
    req = urllib.request.Request(url, data=body, method='POST')
    req.add_header('Content-Type', 'application/json')

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            live_resp = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print(f'ERROR: HERE API returned HTTP {e.code}: {e.read().decode("utf-8", errors="replace")}')
        sys.exit(1)
    except Exception as e:
        print(f'ERROR: live API call failed: {e}')
        sys.exit(1)

    live_sections = live_resp.get('routes', [{}])[0].get('sections', [])
    live_section_count = len(live_sections)
    live_total_len = sum(s.get('summary', {}).get('length', 0) for s in live_sections)
    print(f'DR-augmented live: {live_section_count} sections, {live_total_len} m')

    # --- Compare and optionally replace fixture ---
    if live_section_count < orig_section_count:
        new_fixture = {
            'driveId': drive_id,
            'source': 'mock',
            'createdAt': orig_fixture.get('createdAt', ''),
            'response': live_resp,
            'derived': [],
        }
        with open(fixture_path, 'w') as f:
            json.dump(new_fixture, f, indent=2)
        print(f'FIXTURE REPLACED: {orig_section_count}→{live_section_count} sections, '
              f'{orig_total_len}→{live_total_len} m (source=mock)')
    else:
        print(f'NO REPLACEMENT: section count {live_section_count} >= original {orig_section_count}. '
              f'Original fixture retained. Errata: DR augmentation did not reduce route fragmentation '
              f'({live_section_count} sections / {live_total_len} m vs original {orig_section_count} / {orig_total_len} m).')


if __name__ == '__main__':
    main()
