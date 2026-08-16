/**
 * Whole-screen capture for invigilated exams.
 *
 * Owns the MediaStream for the whole session as a module-level singleton, on
 * purpose: a MediaStream is a live host object, not data. Putting it in Vuex
 * would drag it through the strict-mode deep watcher installed in
 * src/store/index.js, and Vuex mutations are supposed to be synchronous and
 * serialisable. Components read a status string through subscribe() and never
 * touch the stream.
 *
 * Nothing here uploads anything. The capture exists so the browser can prove
 * the candidate is sharing an entire screen, and so the exam can be locked the
 * moment that stops being true. See README for the plan to send frames.
 */

// The invigilated site. quiz.know.tw and exam.know.tw run the same image
// (k8s/base/kustomization.yaml pins the tags for both), so there is no
// build-time flag available — the split has to happen at runtime.
const PROCTORED_HOSTNAMES = ['exam.know.tw']
const DEV_HOSTNAMES = ['localhost', '127.0.0.1']

export const STATUS = {
  IDLE: 'idle',
  REQUESTING: 'requesting',
  ACTIVE: 'active',
  STOPPED: 'stopped',
  REJECTED: 'rejected',
  // No getDisplayMedia at all: phones and tablets.
  UNSUPPORTED: 'unsupported',
  // Has getDisplayMedia but will not tell us which surface was picked, so we
  // cannot prove it is a whole screen. Firefox, today.
  UNVERIFIABLE: 'unverifiable',
  // Not a secure context. Only reachable in development.
  INSECURE: 'insecure'
}

export const REASON = {
  WRONG_SURFACE: 'wrong-surface',
  DENIED: 'denied',
  ERROR: 'error'
}

// What getSettings().displaySurface reports for everything that is not a whole
// screen. 'application' is not in the current spec but shipped in earlier
// drafts, so it is cheap to keep rejecting it.
const NON_MONITOR_SURFACES = ['window', 'browser', 'application']
const WATCHDOG_INTERVAL = 2000

let stream = null
let track = null
let video = null
let watchdog = null
let stopping = false
let subscribers = []

let state = {
  status: STATUS.IDLE,
  reason: null,
  // What they actually picked, when we were rejecting them. For the message.
  surface: null,
  // The OS suspended the capture. Shown on the thumbnail, never re-prompted on.
  muted: false,
  multiDisplay: false
}

function emit () {
  let snapshot = Object.assign({}, state)
  subscribers.forEach(fn => fn(snapshot))
}

function setState (patch) {
  state = Object.assign({}, state, patch)
  emit()
}

/**
 * Subscribe to state changes. Fires immediately with the current state.
 * @param {Function} fn
 * @return {Function} unsubscribe
 */
export function subscribe (fn) {
  subscribers.push(fn)
  fn(Object.assign({}, state))
  return () => {
    subscribers = subscribers.filter(item => item !== fn)
  }
}

export function getState () {
  return Object.assign({}, state)
}

/**
 * Is this the invigilated site?
 *
 * Deliberately keyed on the hostname rather than process.env.NODE_ENV:
 * build/webpack.prod.conf.js replaces the whole `process.env` identifier with
 * an object literal, and UglifyJS does not fold member access on object
 * literals, so a NODE_ENV guard is not reliably eliminated from the bundle. A
 * hostname check can never be true on exam.know.tw whatever the bundler does,
 * which makes the dev override below safe to ship.
 */
export function isProctoredHost () {
  let hostname = window.location.hostname
  if (PROCTORED_HOSTNAMES.indexOf(hostname) !== -1) {
    return true
  }
  return DEV_HOSTNAMES.indexOf(hostname) !== -1 &&
    window.localStorage.getItem('proctorForce') === '1'
}

export function isSecure () {
  // isSecureContext is unset on very old browsers; those fail isSupported()
  // anyway, so treating unknown as secure only changes which message they see.
  return window.isSecureContext !== false
}

export function isSupported () {
  return !!(navigator.mediaDevices &&
    typeof navigator.mediaDevices.getDisplayMedia === 'function')
}

/**
 * Will this engine tell us which surface was shared?
 *
 * Chromium says yes, Firefox says no. Checking up front means an unsupported
 * candidate is told to switch browsers before being asked to share, rather
 * than after picking a screen and being refused.
 */
export function canVerifySurface () {
  if (!navigator.mediaDevices ||
    typeof navigator.mediaDevices.getSupportedConstraints !== 'function') {
    return false
  }
  return navigator.mediaDevices.getSupportedConstraints().displaySurface === true
}

/**
 * The terminal blocking status for this browser, or null if it can be used.
 */
export function browserBlock () {
  if (!isSecure()) return STATUS.INSECURE
  if (!isSupported()) return STATUS.UNSUPPORTED
  if (!canVerifySurface()) return STATUS.UNVERIFIABLE
  return null
}

export function getVideoElement () {
  if (!video) {
    video = document.createElement('video')
    video.autoplay = true
    video.muted = true
    // Both are required for a detached element to autoplay, Safari especially.
    video.setAttribute('muted', '')
    video.setAttribute('playsinline', '')
    // Styled here rather than in the component: this element is created
    // outside Vue, so it carries no data-v- attribute and scoped CSS in the
    // component that adopts it would not match.
    video.style.display = 'block'
    video.style.width = '100%'
  }
  return video
}

function displayMediaOptions () {
  return {
    video: {
      // Only a hint — Chromium uses it to pre-select the "Entire Screen" tab of
      // the picker. The candidate can still switch tabs, so this is never
      // evidence of anything; verifySurface() below is what decides.
      displaySurface: 'monitor',
      // The thumbnail does not need a real frame rate, and capturing a whole
      // screen at 60fps while displaying it back is enough to pin a core.
      frameRate: {ideal: 3, max: 10}
      // No width/height on purpose: constraining them makes getSettings()
      // report the constrained value rather than the surface's own size.
    },
    audio: false,
    // Chromium-only members. Per WebIDL an unrecognised dictionary member is
    // ignored, so other engines degrade without throwing.
    monitorTypeSurfaces: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    systemAudio: 'exclude'
  }
}

/**
 * Decide whether the track we were handed is a whole screen.
 *
 * Note what is NOT used here: track.getConstraints() echoes back the
 * constraints we passed in, and we passed displaySurface: 'monitor', so it
 * always answers 'monitor' no matter what the candidate picked. Using it as a
 * fallback would be a silent pass-everything. getCapabilities() is derived
 * from the same internal source as getSettings() and is equally blank where
 * getSettings() is blank.
 */
function verifySurface (t) {
  let surface = t.getSettings ? t.getSettings().displaySurface : undefined
  if (surface === 'monitor') {
    return {ok: true}
  }
  if (NON_MONITOR_SURFACES.indexOf(surface) !== -1) {
    return {ok: false, reason: REASON.WRONG_SURFACE, surface: surface}
  }
  // Reached by a browser that advertises the displaySurface constraint through
  // getSupportedConstraints() but does not put it in getSettings(), so
  // browserBlock() waved it through. Same verdict, found later.
  return {ok: false, status: STATUS.UNVERIFIABLE}
}

function discard (s) {
  s.getTracks().forEach(t => t.stop())
}

function handleEnded () {
  if (stopping) return
  releaseStream()
  setState({status: STATUS.STOPPED, reason: null, surface: null, muted: false})
}

function handleWrongSurface (surface) {
  if (stopping) return
  releaseStream()
  setState({status: STATUS.REJECTED, reason: REASON.WRONG_SURFACE, surface: surface})
}

function handleMute () {
  setState({muted: true})
}

function handleUnmute () {
  setState({muted: false})
}

/**
 * Re-fired by Chromium when the shared surface changes underneath us. We ask
 * for surfaceSwitching: 'exclude' so the button that does this should not
 * exist, but engines are free to ignore that.
 */
function handleConfigurationChange () {
  if (stopping || !track) return
  let surface = track.getSettings ? track.getSettings().displaySurface : undefined
  if (NON_MONITOR_SURFACES.indexOf(surface) !== -1) {
    handleWrongSurface(surface)
  }
}

/**
 * Backstop for the events above, which are missed on some platforms.
 *
 * Only re-checks displaySurface and readyState — both are cheap and stable.
 * Anything that could flip on a resolution change would lock a candidate out
 * of a perfectly valid share halfway through the exam.
 */
function healthCheck () {
  if (stopping || !track) return
  if (track.readyState !== 'live') {
    handleEnded()
    return
  }
  handleConfigurationChange()
}

function handleVisibility () {
  // setInterval is throttled to roughly once a minute in a background tab, so
  // catch up the moment the tab is looked at again.
  if (document.visibilityState === 'visible') {
    healthCheck()
  }
}

function bind () {
  track.addEventListener('ended', handleEnded)
  track.addEventListener('mute', handleMute)
  track.addEventListener('unmute', handleUnmute)
  track.addEventListener('configurationchange', handleConfigurationChange)
  stream.addEventListener('removetrack', handleEnded)
  document.addEventListener('visibilitychange', handleVisibility)
  watchdog = setInterval(healthCheck, WATCHDOG_INTERVAL)
}

function unbind () {
  if (track) {
    track.removeEventListener('ended', handleEnded)
    track.removeEventListener('mute', handleMute)
    track.removeEventListener('unmute', handleUnmute)
    track.removeEventListener('configurationchange', handleConfigurationChange)
  }
  if (stream) {
    stream.removeEventListener('removetrack', handleEnded)
  }
  document.removeEventListener('visibilitychange', handleVisibility)
  clearInterval(watchdog)
  watchdog = null
}

/**
 * Drop the stream without touching the status, so callers can say why.
 * The video element itself is kept for reuse — recreating it flashes black.
 */
function releaseStream () {
  stopping = true
  unbind()
  if (stream) {
    stream.getTracks().forEach(t => t.stop())
  }
  if (video) {
    video.srcObject = null
  }
  stream = null
  track = null
  stopping = false
}

function onStream (s) {
  let t = s.getVideoTracks()[0]
  if (!t) {
    discard(s)
    setState({status: STATUS.REJECTED, reason: REASON.ERROR, surface: null})
    return false
  }
  // Verified before the stream is ever attached to the video element, so a
  // refused surface is never rendered back to the candidate. displaySurface is
  // on the track from the start; there is nothing to wait for.
  let result = verifySurface(t)
  if (!result.ok) {
    // Must stop the tracks we are refusing, or the browser keeps showing its
    // "sharing your screen" bar for a stream nobody is using.
    discard(s)
    setState({
      status: result.status || STATUS.REJECTED,
      reason: result.reason || null,
      surface: result.surface || null
    })
    return false
  }
  stream = s
  track = t
  getVideoElement().srcObject = s
  bind()
  setState({
    status: STATUS.ACTIVE,
    reason: null,
    surface: 'monitor',
    muted: false,
    // Sharing one screen while working on another defeats the whole thing, and
    // displaySurface cannot see it. Warn; blocking would need the
    // permission-prompting Window Management API.
    multiDisplay: window.screen.isExtended === true
  })
  return true
}

function onError (err) {
  // NotAllowedError covers both "cancelled the picker" and "the OS has not
  // granted this browser screen recording", which is why the message that
  // goes with it mentions macOS privacy settings.
  let reason = err && err.name === 'NotAllowedError' ? REASON.DENIED : REASON.ERROR
  setState({status: STATUS.REJECTED, reason: reason, surface: null})
  return false
}

/**
 * Ask for the screen. MUST be called straight from a click handler with no
 * await in front of it: getDisplayMedia needs transient activation, which is
 * spent by the time a promise you did not trigger resolves. Never call this
 * from mounted(), a timer or a watcher.
 *
 * @return {Promise<boolean>} whether sharing is now active
 */
export function request () {
  let blocked = browserBlock()
  if (blocked) {
    setState({status: blocked, reason: null, surface: null})
    return Promise.resolve(false)
  }
  if (stream) {
    releaseStream()
  }
  setState({status: STATUS.REQUESTING, reason: null, surface: null})
  return navigator.mediaDevices.getDisplayMedia(displayMediaOptions())
    .then(onStream, onError)
}

/**
 * Give the screen back. Safe to call when nothing is shared.
 */
export function stop () {
  releaseStream()
  // Terminal browser verdicts are a property of the browser, not the session —
  // resetting them to IDLE would put a share button back in front of someone
  // on a phone.
  if (browserBlock() || state.status === STATUS.IDLE) {
    return
  }
  setState({status: STATUS.IDLE, reason: null, surface: null, muted: false})
}

export default {
  STATUS,
  REASON,
  subscribe,
  getState,
  isProctoredHost,
  isSecure,
  isSupported,
  canVerifySurface,
  browserBlock,
  getVideoElement,
  request,
  stop
}
