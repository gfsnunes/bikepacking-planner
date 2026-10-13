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
          Bikepacking Day Planner is a free, non-commercial project. It runs entirely in your browser: there is no account and no server
          that stores your data.
        </p>
        <h3>What stays on your device</h3>
        <p>
          The routes, waypoints and settings you open are kept only in this browser (its local storage), so your plan is still here next
          time. Clearing the site's data removes them. Exports are files you save yourself.
        </p>
        <h3>What other services see</h3>
        <ul>
          <li>
            <strong>Map tiles</strong> are loaded from the map provider you pick, which sees which areas of the map you view (like any web
            map).
          </li>
          <li>
            <strong>Elevation lookup</strong> sends your track's coordinates to Open-Meteo, only when you click “Look up elevation” for a
            route without elevation data.
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
          <li>Icons: Lucide (ISC licence).</li>
        </ul>
        <button onClick={() => dialog.current?.close()}>Close</button>
      </dialog>
    </>
  );
}
