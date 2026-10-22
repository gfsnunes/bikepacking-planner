import { useRef } from 'react';

/** Header link + dialog explaining what leaves the browser, and the services' terms. */
export function About() {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <button className="link about-link" onClick={() => dialog.current?.showModal()}>
        About &amp; privacy
      </button>
      <dialog ref={dialog} className="about" onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
        <h2>About &amp; privacy</h2>
        <p>
          Bikepacking Day Planner is a free, non-commercial project. It runs in your browser: there is no account, and nothing you plan
          leaves your device unless you share a trip.
        </p>
        <h3>What stays on your device</h3>
        <p>
          The routes, waypoints and settings you open are kept only in this browser (its local storage), so your plan is still here next
          time. Clearing the site's data removes them. Exports are files you save yourself.
        </p>
        <h3>Shared trips</h3>
        <p>
          “Save &amp; share” uploads the trip to our sharing server so others can plan it with you. It is encrypted in your browser first:
          the key is part of the link (after the #, which browsers never send to a server), so the server stores only data it can’t read.
          It does see when a shared trip is opened and how much data it holds. A shared trip is deleted 90 days after its last change, or
          straight away with “Delete shared trip”. Anyone with the edit link can change or delete it; nobody can recover a trip whose
          link is lost.
        </p>
        <h3>What other services see</h3>
        <ul>
          <li>
            <strong>Road surfaces</strong> (only when you click “Look up” under Road surface) sends your route's coordinates to the
            Valhalla map-matching server run by FOSSGIS e.V. (valhalla1.openstreetmap.de), and the ids of the roads it follows to
            OpenStreetMap's Overpass API, to read their surface tags.
          </li>
          <li>
            <strong>Map tiles</strong> are loaded from the map provider you pick, which sees which areas of the map you view (like any web
            map).
          </li>
          <li>
            <strong>Elevation lookup</strong> sends your track's coordinates to Open-Meteo, only when you click “Look up elevation” for a
            route without elevation data.
          </li>
          <li>
            <strong>Visit counts</strong> come from Cloudflare Web Analytics, which counts page views without cookies or local storage. Your
            routes and waypoints are not sent.
          </li>
        </ul>
        <h3>Data and credits</h3>
        <ul>
          <li>Streets map: OpenFreeMap © OpenMapTiles, data © OpenStreetMap contributors.</li>
          <li>Topo map: © OpenTopoMap (CC-BY-SA), data © OpenStreetMap contributors, SRTM.</li>
          <li>Cycle map: CyclOSM, hosted by OpenStreetMap France, data © OpenStreetMap contributors.</li>
          <li>
            Satellite: EOxCloudless by EOX IT Services GmbH, contains modified Copernicus Sentinel data 2025 (CC BY-NC-SA 4.0,
            non-commercial).
          </li>
          <li>Elevation: Open-Meteo Elevation API, Copernicus DEM GLO-90 (free tier for non-commercial use).</li>
          <li>
            Waypoint library: places © OpenStreetMap contributors, available under the Open Database License (ODbL). Europe comes from a
            built-in library refreshed monthly from Geofabrik extracts (nothing about your route is sent). Elsewhere it searches the public
            Overpass API live, which sends a simplified outline of your route to Overpass.
          </li>
          <li>
            Road surfaces: map matching by Valhalla on the FOSSGIS server; surface and road tags © OpenStreetMap contributors (ODbL).
            Wrong or missing surface? <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">Report or fix it on OpenStreetMap</a>.
          </li>
          <li>Icons: Lucide (ISC licence).</li>
        </ul>
        <h3>Contact</h3>
        <p>
          Questions, problems or requests: <a href="mailto:guilhermefnunes@gmail.com">guilhermefnunes@gmail.com</a>.
        </p>
        <button onClick={() => dialog.current?.close()}>Close</button>
      </dialog>
    </>
  );
}
