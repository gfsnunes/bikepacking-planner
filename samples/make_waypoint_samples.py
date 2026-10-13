"""Generate ~3000 synthetic waypoints around public/sample.gpx in GPX, KML, KMZ, GeoJSON and CSV.

Every file holds the same points, so importing a second format should skip them all as duplicates.
Prints how many lie more than 2 km from the track (to check the bulk delete against).
"""
import json, math, random, re, zipfile
from xml.sax.saxutils import escape

random.seed(3)
track = [(float(a), float(b)) for a, b in re.findall(r'<trkpt lat="([\d.]+)" lon="([\d.]+)"', open('../public/sample.gpx', encoding='utf-8').read())]

KINDS = [
    ('Vindskydd {}', {'amenity': 'shelter'}),
    ('Camping {}', {'tourism': 'camp_site'}),
    ('Stuga {}', {'tourism': 'alpine_hut'}),
    ('Drinking water {}', {'amenity': 'drinking_water'}),
    ('Café {}', {'amenity': 'cafe'}),
    ('ICA {}', {'shop': 'supermarket'}),
    ('Utsikt {}', {'tourism': 'viewpoint'}),
    ('Spot {}', {}),
]
TOWNS = ['Bollnäs', 'Edsbyn', 'Järvsö', 'Ljusdal', 'Arbrå', 'Alfta', 'Vallsta', 'Delsbo', 'Kilafors', 'Söderala']

def haversine(a, b):
    R = 6371008.8
    la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * R * math.asin(min(1, math.sqrt(h)))

pts = []
for i in range(3000):
    base = random.choice(track)
    d = random.uniform(0, 20000) if random.random() < 0.7 else random.uniform(0, 1500)
    th = random.uniform(0, 2 * math.pi)
    lat = base[0] + d * math.cos(th) / 111195
    lon = base[1] + d * math.sin(th) / (111195 * math.cos(math.radians(base[0])))
    tmpl, tags = random.choice(KINDS)
    name = tmpl.format(f'{random.choice(TOWNS)} {i + 1}')
    pts.append((round(lat, 6), round(lon, 6), name, tags))

far = sum(1 for p in pts if min(haversine((p[0], p[1]), t) for t in track[::2]) > 2000)
print(f'{len(pts)} waypoints, {far} more than 2 km from the track (track sampled every 2nd point)')

with open('waypoints-3000.gpx', 'w', encoding='utf-8') as f:
    f.write('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="synthetic" xmlns="http://www.topografix.com/GPX/1/1">\n')
    for lat, lon, name, _ in pts:
        f.write(f'  <wpt lat="{lat}" lon="{lon}"><name>{escape(name)}</name></wpt>\n')
    f.write('</gpx>\n')

kml = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>']
for lat, lon, name, _ in pts:
    kml.append(f'<Placemark><name>{escape(name)}</name><Point><coordinates>{lon},{lat},0</coordinates></Point></Placemark>')
kml.append('</Document></kml>')
open('waypoints-3000.kml', 'w', encoding='utf-8').write('\n'.join(kml))
with zipfile.ZipFile('waypoints-3000.kmz', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('doc.kml', '\n'.join(kml))

json.dump({'type': 'FeatureCollection', 'features': [
    {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [lon, lat]}, 'properties': {'name': name, **tags}}
    for lat, lon, name, tags in pts]}, open('waypoints-3000.geojson', 'w', encoding='utf-8'), ensure_ascii=False)

with open('waypoints-3000.csv', 'w', encoding='utf-8') as f:
    f.write('Name;Latitude;Longitude\n')
    for lat, lon, name, _ in pts:
        f.write(f'"{name}";{str(lat).replace(".", ",")};{str(lon).replace(".", ",")}\n')
print('written')
