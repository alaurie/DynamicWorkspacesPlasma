/*
    SPDX-FileCopyrightText: 2026 DynamicWorkspacesPlasma Contributors
    SPDX-License-Identifier: GPL-2.0-or-later
*/

/**
 * Dynamic Workspaces for KWin 6 (Plasma 6.x)
 *
 * - GNOME-style dynamic virtual desktops: always maintains one empty trailing
 *   desktop and prunes extra empty desktops once you switch away from them.
 * - Designed to work seamlessly with "Virtual Desktops Only on Primary"
 *   (windows with onAllDesktops === true do not count as occupying a desktop).
 * - Copies Shift+T (Custom Tiling) layouts to newly created and switched
 *   desktops on secondary monitors, and preserves secondary monitor window
 *   tile assignments and frame geometries across desktop switches.
 */

const config = {
    keepEmptyTrailingDesktop: true,
    removeEmptyIntermediateDesktops: true,
    syncSecondaryTiles: true,
    syncPrimaryTiles: false,
    preserveSecondaryWindowPlacement: true,
    desktopNamePrefix: "",
    debugLogging: false
};

let primaryScreen = null;
let isReconciling = false;
let isSyncing = false;

/** @type {Set<Window>} */
const trackedWindows = new Set();

/** @type {Map<Window, { output: Output, frameGeometry: {x:number, y:number, width:number, height:number}, tileRelGeom: {x:number, y:number, width:number, height:number}|null }>} */
const secondaryWindowState = new Map();

function log(message) {
    if (config.debugLogging) {
        console.info("dynamicworkspaces: " + message);
    }
}

function loadConfig() {
    config.keepEmptyTrailingDesktop = readConfig("KeepEmptyTrailingDesktop", true);
    config.removeEmptyIntermediateDesktops = readConfig("RemoveEmptyIntermediateDesktops", true);
    config.syncSecondaryTiles = readConfig("SyncSecondaryTiles", true);
    config.syncPrimaryTiles = readConfig("SyncPrimaryTiles", false);
    config.preserveSecondaryWindowPlacement = readConfig("PreserveSecondaryWindowPlacement", true);
    config.desktopNamePrefix = readConfig("DesktopNamePrefix", "");
    config.debugLogging = readConfig("DebugLogging", false);
    log("Config loaded: " + JSON.stringify(config));
}

function updatePrimaryScreen() {
    if (workspace.screenOrder && workspace.screenOrder.length > 0) {
        primaryScreen = workspace.screenOrder[0];
    } else if (workspace.screens && workspace.screens.length > 0) {
        primaryScreen = workspace.screens[0];
    } else {
        primaryScreen = workspace.activeScreen;
    }
}

function cloneRect(r) {
    if (!r) return null;
    return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height
    };
}

function rectsAlmostEqual(a, b, eps) {
    if (!a || !b) return false;
    return Math.abs(a.x - b.x) <= eps &&
           Math.abs(a.y - b.y) <= eps &&
           Math.abs(a.width - b.width) <= eps &&
           Math.abs(a.height - b.height) <= eps;
}

/**
 * Determines whether a window counts as occupying a specific virtual desktop.
 * Windows pinned to all desktops (including secondary-monitor windows managed
 * by "Virtual Desktops Only on Primary") do not count as occupying a desktop.
 */
function isDesktopOccupyingWindow(w) {
    if (!w) return false;
    if (!w.normalWindow) return false;
    if (w.specialWindow) return false;
    if (w.skipTaskbar || w.skipPager) return false;
    if (w.onAllDesktops) return false;
    return true;
}

function isDesktopEmpty(desktop) {
    const windows = workspace.windowList();
    for (let i = 0; i < windows.length; i++) {
        const w = windows[i];
        if (!isDesktopOccupyingWindow(w)) continue;
        if (w.desktops && w.desktops.includes(desktop)) {
            return false;
        }
    }
    return true;
}

function isSecondaryWindow(w) {
    if (!w || !primaryScreen) return false;
    if (!w.normalWindow || !w.moveableAcrossScreens) return false;
    return w.output !== primaryScreen;
}

function snapshotSecondaryWindow(w) {
    if (!config.preserveSecondaryWindowPlacement) return;
    if (isSyncing) return;

    if (!isSecondaryWindow(w)) {
        secondaryWindowState.delete(w);
        return;
    }

    const prev = secondaryWindowState.get(w);
    const currentFg = cloneRect(w.frameGeometry);
    let tileRelGeom = w.tile ? cloneRect(w.tile.relativeGeometry) : null;

    // If KWin cleared w.tile during a desktop transition without moving the window,
    // keep the previous tileRelGeom so we don't lose the snapped slot.
    if (!tileRelGeom && prev && prev.tileRelGeom && rectsAlmostEqual(currentFg, prev.frameGeometry, 2.0)) {
        tileRelGeom = prev.tileRelGeom;
    }

    secondaryWindowState.set(w, {
        output: w.output,
        frameGeometry: currentFg,
        tileRelGeom: tileRelGeom
    });
}

function tileTreesEqual(a, b) {
    if (!a || !b) return false;
    if (a.layoutDirection !== b.layoutDirection) return false;
    if (a.padding !== undefined && b.padding !== undefined && Math.abs(a.padding - b.padding) > 0.5) {
        return false;
    }
    if (!rectsAlmostEqual(a.relativeGeometry, b.relativeGeometry, 0.002)) {
        return false;
    }
    const aChildren = a.tiles || [];
    const bChildren = b.tiles || [];
    if (aChildren.length !== bChildren.length) return false;
    for (let i = 0; i < aChildren.length; i++) {
        if (!tileTreesEqual(aChildren[i], bChildren[i])) {
            return false;
        }
    }
    return true;
}

function clearTileChildren(tile) {
    let guard = 0;
    while (tile.tiles && tile.tiles.length > 0 && guard < 64) {
        guard++;
        const prevLen = tile.tiles.length;
        const child = tile.tiles[tile.tiles.length - 1];
        clearTileChildren(child);
        child.remove();
        if (tile.tiles.length >= prevLen) {
            // KWin may refuse to remove the last remaining child of a RootTile
            break;
        }
    }
}

function setTileRelativeGeometry(tile, rg) {
    const rect = Qt.rect(rg.x, rg.y, rg.width, rg.height);
    if (typeof tile.setRelativeGeometry === "function") {
        tile.setRelativeGeometry(rect);
    } else {
        tile.relativeGeometry = rect;
    }
}

function copyTileNode(srcTile, dstTile) {
    if (srcTile.padding !== undefined && dstTile.padding !== srcTile.padding) {
        dstTile.padding = srcTile.padding;
    }

    const srcChildren = srcTile.tiles || [];
    if (srcChildren.length === 0) {
        return;
    }

    const dir = srcTile.layoutDirection;
    if (typeof dstTile.setLayoutDirection === "function") {
        dstTile.setLayoutDirection(dir);
    } else {
        dstTile.layoutDirection = dir;
    }

    if (srcChildren.length === 1) {
        if (dstTile.tiles && dstTile.tiles.length === 1) {
            setTileRelativeGeometry(dstTile.tiles[0], srcChildren[0].relativeGeometry);
            copyTileNode(srcChildren[0], dstTile.tiles[0]);
        } else {
            copyTileNode(srcChildren[0], dstTile);
        }
        return;
    }

    // Ensure dstTile has at least 2 children, whether it started with 0 or 1 child
    if (!dstTile.tiles || dstTile.tiles.length === 0) {
        dstTile.split(dir);
    } else if (dstTile.tiles.length === 1) {
        dstTile.tiles[0].split(dir);
    }

    let guard = 0;
    while (dstTile.tiles.length < srcChildren.length && guard < 32) {
        guard++;
        const prevLen = dstTile.tiles.length;
        const lastChild = dstTile.tiles[dstTile.tiles.length - 1];
        lastChild.split(dir);
        if (dstTile.tiles.length <= prevLen) {
            break;
        }
    }

    const dstChildren = dstTile.tiles;
    const count = Math.min(srcChildren.length, dstChildren.length);
    for (let i = 0; i < count; i++) {
        setTileRelativeGeometry(dstChildren[i], srcChildren[i].relativeGeometry);
    }
    for (let i = 0; i < count; i++) {
        copyTileNode(srcChildren[i], dstChildren[i]);
    }
}

function copyRootTile(output, srcDesktop, dstDesktop) {
    if (!output || !srcDesktop || !dstDesktop || srcDesktop === dstDesktop) return;
    if (typeof workspace.rootTile !== "function") return;

    const srcRoot = workspace.rootTile(output, srcDesktop);
    const dstRoot = workspace.rootTile(output, dstDesktop);
    if (!srcRoot || !dstRoot || srcRoot === dstRoot) return;

    if (tileTreesEqual(srcRoot, dstRoot)) {
        return;
    }

    log("Copying rootTile for output " + output.name + " from desktop '" + srcDesktop.name + "' to '" + dstDesktop.name + "'");
    clearTileChildren(dstRoot);
    copyTileNode(srcRoot, dstRoot);
}

function syncTilesBetweenDesktops(srcDesktop, dstDesktop, includePrimary, includeSecondary) {
    if (!srcDesktop || !dstDesktop || srcDesktop === dstDesktop) return;
    const screens = workspace.screens || [];
    for (let i = 0; i < screens.length; i++) {
        const output = screens[i];
        const isPrimary = (output === primaryScreen);
        if ((isPrimary && includePrimary) || (!isPrimary && includeSecondary)) {
            copyRootTile(output, srcDesktop, dstDesktop);
        }
    }
}

function collectLeafTiles(tile, out) {
    const children = tile.tiles || [];
    if (children.length === 0) {
        out.push(tile);
        return;
    }
    for (let i = 0; i < children.length; i++) {
        collectLeafTiles(children[i], out);
    }
}

function findMatchingTile(rootTile, targetRelGeom) {
    if (!rootTile || !targetRelGeom) return null;
    const leaves = [];
    collectLeafTiles(rootTile, leaves);
    if (leaves.length === 0) return null;

    const targetCx = targetRelGeom.x + targetRelGeom.width / 2;
    const targetCy = targetRelGeom.y + targetRelGeom.height / 2;

    let bestTile = null;
    let bestScore = Infinity;

    for (let i = 0; i < leaves.length; i++) {
        const leaf = leaves[i];
        const rg = leaf.relativeGeometry;
        const cx = rg.x + rg.width / 2;
        const cy = rg.y + rg.height / 2;
        const score = Math.abs(cx - targetCx) +
                      Math.abs(cy - targetCy) +
                      Math.abs(rg.width - targetRelGeom.width) +
                      Math.abs(rg.height - targetRelGeom.height);
        if (score < bestScore) {
            bestScore = score;
            bestTile = leaf;
        }
    }
    return bestTile;
}

function findTileForWindowInRoot(rootTile, w) {
    if (!rootTile || !w) return null;
    const leaves = [];
    collectLeafTiles(rootTile, leaves);
    for (let i = 0; i < leaves.length; i++) {
        const wins = leaves[i].windows || [];
        for (let j = 0; j < wins.length; j++) {
            if (wins[j] === w) {
                return leaves[i];
            }
        }
    }
    return null;
}

function restoreSecondaryWindows(oldDesktop, targetDesktop) {
    if (!config.preserveSecondaryWindowPlacement) return;
    if (!targetDesktop) return;

    isSyncing = true;
    try {
        const windows = workspace.windowList();
        for (let i = 0; i < windows.length; i++) {
            const w = windows[i];
            if (!isSecondaryWindow(w) || !w.onAllDesktops) continue;

            let targetRelGeom = null;
            if (oldDesktop && typeof workspace.rootTile === "function") {
                const oldRoot = workspace.rootTile(w.output, oldDesktop);
                const oldTile = findTileForWindowInRoot(oldRoot, w);
                if (oldTile) {
                    targetRelGeom = cloneRect(oldTile.relativeGeometry);
                }
            }

            const state = secondaryWindowState.get(w);
            if (!targetRelGeom && state && state.tileRelGeom) {
                targetRelGeom = state.tileRelGeom;
            }

            if (targetRelGeom && typeof workspace.rootTile === "function") {
                const dstRoot = workspace.rootTile(w.output, targetDesktop);
                const match = findMatchingTile(dstRoot, targetRelGeom);
                if (match) {
                    if (w.tile !== match) {
                        log("Assigning secondary window '" + w.caption + "' to matching tile on '" + targetDesktop.name + "'");
                        w.tile = match;
                    }
                    // Update snapshot for the new desktop and do not overwrite frameGeometry,
                    // since setting frameGeometry manually after w.tile = match can un-tile the window.
                    secondaryWindowState.set(w, {
                        output: w.output,
                        frameGeometry: cloneRect(match.absoluteGeometry || w.frameGeometry),
                        tileRelGeom: cloneRect(match.relativeGeometry)
                    });
                    continue;
                }
            }

            // Floating (untiled) window on secondary monitor: preserve exact frameGeometry
            if (state && state.frameGeometry && !rectsAlmostEqual(w.frameGeometry, state.frameGeometry, 1.0)) {
                const fg = state.frameGeometry;
                w.frameGeometry = Qt.rect(fg.x, fg.y, fg.width, fg.height);
            }
        }
    } finally {
        isSyncing = false;
    }
}

function reconcileDesktops() {
    if (isReconciling) return;
    isReconciling = true;

    try {
        // 1. Remove extra empty desktops (never removing currentDesktop or the last remaining desktop)
        if (config.removeEmptyIntermediateDesktops) {
            let safety = 0;
            while (safety < 32) {
                safety++;
                const desktops = workspace.desktops;
                if (!desktops || desktops.length <= 1) break;

                let removed = false;

                // Remove any empty intermediate desktop that is not the current desktop
                for (let i = 0; i < desktops.length - 1; i++) {
                    const d = desktops[i];
                    if (d !== workspace.currentDesktop && isDesktopEmpty(d)) {
                        log("Removing empty intermediate desktop: " + d.name);
                        workspace.removeDesktop(d);
                        removed = true;
                        break;
                    }
                }
                if (removed) continue;

                // If the last two desktops are both empty and the last one isn't current, remove the last one
                if (desktops.length >= 2) {
                    const last = desktops[desktops.length - 1];
                    const prev = desktops[desktops.length - 2];
                    if (last !== workspace.currentDesktop && isDesktopEmpty(last) && isDesktopEmpty(prev)) {
                        log("Removing redundant trailing empty desktop: " + last.name);
                        workspace.removeDesktop(last);
                        continue;
                    }
                }

                break;
            }
        }

        // 2. Ensure there is always an empty trailing desktop
        if (config.keepEmptyTrailingDesktop) {
            const desktops = workspace.desktops;
            if (desktops && desktops.length > 0) {
                const last = desktops[desktops.length - 1];
                if (!isDesktopEmpty(last)) {
                    const sourceDesktop = workspace.currentDesktop || last;
                    const nextNum = desktops.length + 1;
                    const name = config.desktopNamePrefix ? (config.desktopNamePrefix + " " + nextNum) : "";
                    log("Creating new trailing empty desktop at index " + desktops.length);
                    workspace.createDesktop(desktops.length, name);

                    const updated = workspace.desktops;
                    const newDesktop = updated[updated.length - 1];
                    if (newDesktop && newDesktop !== last) {
                        isSyncing = true;
                        try {
                            syncTilesBetweenDesktops(
                                sourceDesktop,
                                newDesktop,
                                config.syncPrimaryTiles,
                                config.syncSecondaryTiles
                            );
                        } finally {
                            isSyncing = false;
                        }
                    }
                }
            }
        }
    } finally {
        isReconciling = false;
    }
}

function trackWindow(w) {
    if (!w || trackedWindows.has(w)) return;
    trackedWindows.add(w);

    snapshotSecondaryWindow(w);

    w.desktopsChanged.connect(() => {
        reconcileDesktops();
    });

    w.outputChanged.connect(() => {
        snapshotSecondaryWindow(w);
        reconcileDesktops();
    });

    w.tileChanged.connect(() => {
        snapshotSecondaryWindow(w);
    });

    w.frameGeometryChanged.connect(() => {
        snapshotSecondaryWindow(w);
    });

    w.closed.connect(() => {
        trackedWindows.delete(w);
        secondaryWindowState.delete(w);
        reconcileDesktops();
    });
}

function onCurrentDesktopChanged(oldDesktop) {
    const newDesktop = workspace.currentDesktop;
    if (oldDesktop && newDesktop && oldDesktop !== newDesktop) {
        isSyncing = true;
        try {
            syncTilesBetweenDesktops(oldDesktop, newDesktop, false, config.syncSecondaryTiles);
        } finally {
            isSyncing = false;
        }
        restoreSecondaryWindows(oldDesktop, newDesktop);
    }
    reconcileDesktops();
}

function onScreensChanged() {
    updatePrimaryScreen();
    const windows = workspace.windowList();
    for (let i = 0; i < windows.length; i++) {
        snapshotSecondaryWindow(windows[i]);
    }
    reconcileDesktops();
}

function main() {
    loadConfig();
    updatePrimaryScreen();

    const windows = workspace.windowList();
    for (let i = 0; i < windows.length; i++) {
        trackWindow(windows[i]);
    }

    workspace.windowAdded.connect((w) => {
        trackWindow(w);
        reconcileDesktops();
    });

    workspace.windowRemoved.connect((w) => {
        trackedWindows.delete(w);
        secondaryWindowState.delete(w);
        reconcileDesktops();
    });

    workspace.currentDesktopChanged.connect(onCurrentDesktopChanged);
    workspace.desktopsChanged.connect(() => {
        reconcileDesktops();
    });
    workspace.screensChanged.connect(onScreensChanged);
    workspace.screenOrderChanged.connect(onScreensChanged);

    if (options && options.configChanged) {
        options.configChanged.connect(loadConfig);
    }

    reconcileDesktops();
    log("Dynamic Workspaces initialized.");
}

main();
