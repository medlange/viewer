/* =====================================================================================
 * THE VIEWER'S OWN DEFAULTS. A deployment overrides this file; it does not edit it.
 *
 * WHAT THIS SEAM IS FOR. `app.js` used to build its DICOMweb client against
 * `/dicomweb/${TENANT}` with the tenant read from the query string, and `dicomweb.js` sent
 * `X-MedicalOS-Surface: clinical_viewer` on every request. Neither is DICOMweb: PS3.18
 * defines the service paths under a root and says nothing about what precedes it, a tenant
 * segment is one gateway's way of making an authorisation check possible, and a consumer
 * class is one platform's vocabulary. Four lines, and they meant this viewer could not be
 * pointed at an Orthanc, a dcm4chee, or anything else conformant.
 *
 * THE VALUES BELOW ARE A PLAIN DICOMWEB CLIENT, which is what this viewer is when nobody
 * has told it otherwise:
 *
 *   dicomWebRoot  '/dicomweb' -- the conventional prefix, and where this project's own
 *                 nginx proxies its Gateway. Any origin serving QIDO/WADO-RS under it
 *                 answers a viewer configured this way.
 *   tenant        none. A path segment after the root, for origins that scope by one. It
 *                 is appended only when set, so the default path is the standard shape.
 *   surface       none, AND NOT A DEFAULT VALUE. Declaring a consumer class to an origin
 *                 that never granted one is a claim the viewer is not entitled to make;
 *                 an absent header is the honest statement that nobody asked.
 *
 * A HOST OVERRIDES BY REPLACING THIS FILE -- a bind mount, a build step, a handler that
 * serves different bytes at this path. `deploy/compose/viewer-config.js` in this
 * repository is that file for the MedicalOS deployment, and its header says what each of
 * its values buys. Nothing in `src/` reads anything but `window.VIEWER_CONFIG`.
 * ===================================================================================== */

window.VIEWER_CONFIG = {
  dicomWebRoot: '/dicomweb',
};
