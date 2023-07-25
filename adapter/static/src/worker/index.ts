import type {
	InstallEvent,
	ActivateEvent,
	FetchEvent,

	VersionFile,
	VWRequestMode,
	HandleFetchHook,
	InputMessageData,
	InputMessageEvent,
	WindowClient,
	OutputMessageData
} from "sveltekit-adapter-versioned-worker/worker";

import {
	ROUTES,
	PRECACHE,
	LAX_LAZY,
	STALE_LAZY,
	STRICT_LAZY,
	SEMI_LAZY,

	STORAGE_PREFIX,
	VERSION,
	VERSION_FOLDER,
	VERSION_FILE_BATCH_SIZE,
	MAX_VERSION_FILES,
	BASE_URL,

	ENABLE_PASSTHROUGH
} from "sveltekit-adapter-versioned-worker/worker";

import {
	VIRTUAL_FETCH_PREFIX,

	modifyRequestHeaders,
	modifyResponseHeaders,
	isResponseTheDefault,
	summarizeRequest
} from "sveltekit-adapter-versioned-worker/internal/worker-util-alias";
import { workerState } from "sveltekit-adapter-versioned-worker/internal/worker-shared";
import * as hooks from "sveltekit-adapter-versioned-worker/internal/hooks";

type Nullable<T> = T | null;

const currentStorageName = STORAGE_PREFIX + VERSION;
const COMPLETE_CACHE_LIST = new Set<string>([
	...ROUTES,
	...PRECACHE,
	...LAX_LAZY,
	...STALE_LAZY,
	...STRICT_LAZY,
	...SEMI_LAZY
]);
const REUSABLE_BETWEEN_VERSIONS = new Set<string>([
	...LAX_LAZY,
	...STALE_LAZY
]);
const cachePromise = caches.open(currentStorageName);

/* Optional functions */
// The code referencing them might be unreachable depending on the config, so some of these might not be in the build

const handleQuickFetch = (async ({ searchParams, request }) => {
	const unwrappedURL = searchParams.get("url");
	const specifiedHeadersRaw = searchParams.get("specified");
	if (unwrappedURL == null || specifiedHeadersRaw == null) {
		console.error("Versioned Worker quick fetch: invalid request.");
		return Response.error();
	}

	const unwrappedRequest = new Request(unwrappedURL, request);
	const stringRequest = JSON.stringify(summarizeRequest(unwrappedRequest, JSON.parse(specifiedHeadersRaw)));
	const fetchPromise = workerState.quickFetchPromises.get(stringRequest);

	if (fetchPromise) {
		workerState.quickFetchPromises.delete(stringRequest);
		return await fetchPromise;
	}
	else {
		return await fetch(unwrappedRequest);
	}
}) satisfies HandleFetchHook;

/* End of optional functions */


addEventListener("install", e => {
    (e as InstallEvent).waitUntil(
		(async () => {
			const installedVersions = await getInstalled();
			const updatedList = await getUpdated(installedVersions);

			const toDownload = new Set<string>([
				...ROUTES,
				...PRECACHE
			]);
			const toCopy = new Map<string, [containingCache: Cache, isStale: boolean, fromVersion: number]>(); // The key is the path
			if (updatedList) { // Don't reuse anything if it's a clean install
				const cacheNames = await caches.keys();
				for (const cacheName of cacheNames) {
					if (! cacheName.startsWith(STORAGE_PREFIX)) continue;
					if (cacheName === currentStorageName) continue;
					
					const cache = await caches.open(cacheName);
					const pathsInCache = (await cache.keys()).map(req => new URL(req.url).pathname.slice(BASE_URL.length));
					const cacheVersion = parseInt(cacheName.slice(STORAGE_PREFIX.length));
					for (const path of pathsInCache) {
						const changed = updatedList.has(path) || ROUTES.includes(path);
						if (PRECACHE.includes(path)) {
							if (toDownload.has(path) && (! changed)) {
								toDownload.delete(path);
		
								addToToCopyIfNewer(false);
							}
						}
						else if (SEMI_LAZY.includes(path)) {
							if (changed) {
								toDownload.add(path);
							}
							else {
								addToToCopyIfNewer(false);
							}
						}
						else if (COMPLETE_CACHE_LIST.has(path)) {
							const staleAndAcceptable = changed && REUSABLE_BETWEEN_VERSIONS.has(path); // Don't check if it's in REUSABLE_BETWEEN_VERSIONS if it's unchanged
							const reusable = (! changed) || staleAndAcceptable;

							if (reusable) addToToCopyIfNewer(changed); // If it's reusable and has changed then it's stale
						}


						function addToToCopyIfNewer(isStale: boolean) {
							const itemInToCopy = toCopy.get(path);
							const valueToPut: [Cache, boolean, number] = [cache, isStale, cacheVersion];
							if (itemInToCopy) {
								if (cacheVersion > itemInToCopy[2]) { // This assset is newer, use it instead
									toCopy.set(path, valueToPut);
								}
							}
							else {
								toCopy.set(path, valueToPut);
							}
						}
					}
				}
			}
			else {
				console.warn("Versioned Worker: Performing clean install");
			}

			const cache = await cachePromise;
			await Promise.all([
				...[...toDownload].map(async path => {
					if (path === "") path = BASE_URL; // Otherwise it'll point to sw.js
					const res = addVWHeaders(await fetch(path, { cache: "no-cache" }));
					if (! isResponseUsable(res)) throw "";

					await cache.put(path, res);
				}),
				...[...toCopy].map(async ([path, [oldCache, isStale]]) => {
					const existing = (await oldCache.match(path)) as Response; // It was already found in the cache before
					const withUpdatedVersionHeader = isStale?
						existing
						: addVWHeaders(existing) // Update the "vw-version" header
					;

					await cache.put(path, withUpdatedVersionHeader);
				})
			]);

			const activeClients = await clients.matchAll({ includeUncontrolled: true });
			activeClients.forEach(client => client.postMessage({ type: "vw-waiting" } satisfies OutputMessageData));
		})()
	);
});

addEventListener("activate", e => {
	(e as ActivateEvent).waitUntil(
		(async () => {
			clients.claim();

			// Clean up
			const cacheNames = await caches.keys();
			for (const cacheName of cacheNames) {
				const hasAnOldName = cacheName.startsWith("VersionedWorkerStorage-") || cacheName.startsWith("VersionedWorkerCache-");
				if (! (cacheName.startsWith(STORAGE_PREFIX) || hasAnOldName)) continue;
				if (cacheName === currentStorageName) continue;

				await caches.delete(cacheName); // There'll probably only be 1 anyway so it's not worth doing in parallel
			}
		})()
	);
});
addEventListener("fetch", e => {
	const fetchEvent = e as FetchEvent;
	const req = fetchEvent.request;
	const urlObj = new URL(req.url);
	const fullPath = urlObj.pathname;
	const pathWithoutBase = fullPath.slice(BASE_URL.length);
	const hasVirtualPrefix = pathWithoutBase.startsWith(VIRTUAL_FETCH_PREFIX);
	const searchParams = urlObj.searchParams;
	const vwMode = getVWRequestMode(req, hasVirtualPrefix, searchParams);
	if (vwMode === "force-passthrough") return;

	const isGetRequest = req.method === "GET";
	const isHeadRequest = req.method === "HEAD";
	const isPage = req.mode === "navigate" && isGetRequest;
	const isCrossOrigin = urlObj.origin !== location.origin;
	const inCacheList = (! isCrossOrigin) && (isGetRequest || isHeadRequest) && COMPLETE_CACHE_LIST.has(pathWithoutBase);

	const virtualHref = hasVirtualPrefix? pathWithoutBase.slice(VIRTUAL_FETCH_PREFIX.length) : null;
	const fetchHandler = selectHandleFetchFunction(virtualHref, isCrossOrigin);
	let handleOutput: Promise<Nullable<Response>> | Nullable<Response> = null;
	if (fetchHandler) {
		handleOutput = fetchHandler({
			href: pathWithoutBase,
			fullHref: fullPath,
			virtualHref,
			searchParams,
			urlObj,
			isPage,
			isCrossOrigin,
			vwMode,
			inCacheList,
			request: req,
			event: fetchEvent
		});

		if (ENABLE_PASSTHROUGH) {
			if (handleOutput == null && (! inCacheList) && vwMode !== "handle-only") return;
		}
	}

    fetchEvent.respondWith(
        (async (): Promise<Response> => {
			if (vwMode !== "handle-only") {
				if (isPage && registration.waiting) { // Based on https://redfin.engineering/how-to-fix-the-refresh-button-when-using-service-workers-a8e27af6df68
					const activeClients = await clients.matchAll();
					if (activeClients.length < 2) {
						// TODO
						//registration.waiting.postMessage({ type: "skipWaiting" } satisfies MessageEventData);
						//return new Response("", { headers: { Refresh: "0" } }); // Send an empty response but with a refresh header so it reloads instantly
					}
				}
			}
			
			if (handleOutput) {
				handleOutput = await handleOutput;
				if (handleOutput != null) return handleOutput;
			}
			if (vwMode === "handle-only") return Response.error();

			if (isCrossOrigin || (! (isGetRequest || isHeadRequest))) { // Sort of passthrough: no headers are added
				try {
					return await fetch(req);
				}
				catch {
					return Response.error();
				}
			}

			const cache = await cachePromise;
			if (inCacheList) {
				const modifiedRequest = modifyRequestForCaching(req);
				let cached = await cache.match(modifiedRequest);
				if (cached) {
					const stale = parseInt(cached.headers.get("vw-version") as string) !== VERSION;
					if (! stale) return handleHeadRequest(cached, isHeadRequest);

					if (vwMode === "no-network" || STALE_LAZY.includes(pathWithoutBase)) {
						if (vwMode !== "no-network") updateResourceInBackground(modifiedRequest, cache, fetchEvent);
						return handleHeadRequest(cached, isHeadRequest); // The outdated version
					}
					else { // Must be a lax-lazy resource
						const [resource, isError] = await fetchResource(pathWithoutBase, modifiedRequest, isPage);
						if (! isError) return handleHeadRequest(cached, isHeadRequest);

						updateResourceInBackground(modifiedRequest, cache, fetchEvent, resource.clone());
						return handleHeadRequest(resource, isHeadRequest);
					}
				}
			}

			/* The response won't already be in the cache if this point is reached (but could be in the cache list) */
			if (vwMode === "no-network") return Response.error();

			const modifiedRequest = modifyRequestForCaching(req, false); // Could be a HEAD request
			const [resource, isError] = await fetchResource(pathWithoutBase, modifiedRequest, isPage);
			if (isError || isHeadRequest) return resource; // Send the error response or send the HEAD response from the server if applicable, as it can't be cached

			if (inCacheList) updateResourceInBackground(modifiedRequest, cache, fetchEvent, resource.clone());
			return handleHeadRequest(resource, isHeadRequest);
        })()
    );
});
interface InputMessageEventBase extends MessageEvent {
	data: InputMessageData | "skipWaiting"
} 
addEventListener("message", async ({ data: backwardCompatibleData }: InputMessageEventBase) => {
	// We're going to assume that invalid data will never be post-messaged here

	let data: InputMessageData;
	if (backwardCompatibleData === "skipWaiting") {
		data = { type: "skipWaiting" };
	}
	else {
		data = backwardCompatibleData;
	}

	if (data.type === "skipWaiting") {
		console.log("Skipped"); // TODO
		skipWaiting();
	}
	else if (data.type === "conditionalSkipWaiting") {
		const activeClients = (await clients.matchAll({ includeUncontrolled: true })) as WindowClient[];
		console.log(activeClients.length, VERSION);
		if (activeClients.length < 2) {
			await Promise.all(activeClients.map(client => client.navigate(client.url)));
			skipWaiting();
		}
	}
});

function parseUpdatedList(contents: string): VersionFile {
	contents = contents.split("\r\n").join("\n");

	const splitPoint = contents.indexOf("\n");
	const version = contents.slice(0, splitPoint);
	const formatSupported = version === "2";
	
	let updated: string[][] = [];
	if (formatSupported) {
		updated = contents.slice(splitPoint + 1)
			.split("\n\n")
			.map(updatedList => {
				let parsed = updatedList.split("\n");
				if (parsed[0] === "") return [];
				else return parsed;
			})
		;
	}

	return {
		formatVersion: formatSupported? 2 : -1,
		updated: updated
	};
}
async function getInstalled(): Promise<number[]> {
	let installedVersions = [];

	const cacheNames = await caches.keys();
	for (const cacheName of cacheNames) {
		if (! cacheName.startsWith(STORAGE_PREFIX)) continue;
		if (cacheName === currentStorageName) continue;

		installedVersions.push(
			parseInt(cacheName.slice(STORAGE_PREFIX.length))
		);
	}
	
	installedVersions = installedVersions.sort((n1, n2) => n2 - n1); // Newest (highest) first
	return installedVersions;
}
async function getUpdated(installedVersions: number[]): Promise< Nullable<Set<string>> > {
	if (installedVersions.length === 0) return null; // Clean install
	const newestInstalled = Math.max(...installedVersions);
	if (newestInstalled >= VERSION) return null; // The version number has gone down for some reason, so clean install
	
	/* Fetch all the version files between the versions */

	// Once the number of version files reaches MAX_VERSION_FILES, the version files are shifted down by 1
	// + 1 and ceil so v100 gives an offset of -1 and <= -2 starts at 110 
	const batchOffset = Math.min(MAX_VERSION_FILES - Math.ceil((VERSION + 1) / VERSION_FILE_BATCH_SIZE), 0); // Always <= 0

	const rangeToDownload = [
		Math.floor((newestInstalled + 1) / VERSION_FILE_BATCH_SIZE) + batchOffset, // +1 because we don't need this version file if the installed version is the last one in it
		Math.floor(VERSION / VERSION_FILE_BATCH_SIZE) + batchOffset
	];
	if (rangeToDownload[0] < 0) return null; // The current installed version is too old, do a clean install

	const idInBatchOfOneAfterInstalled = (newestInstalled + 1) % VERSION_FILE_BATCH_SIZE;
	const installedInDownloadRange = idInBatchOfOneAfterInstalled !== 0; // If it's the last version in the batch, it won't be
	const numberToDownload = (rangeToDownload[1] - rangeToDownload[0]) + 1;
	
	let versionFiles = await Promise.all(
		new Array(numberToDownload).fill(null).map(async (_, offset): Promise<VersionFile> => {
			let fileID = offset + rangeToDownload[0];
			const res = await fetch(`${VERSION_FOLDER}/${fileID}.txt`, { cache: "no-cache" });
			if (! isResponseUsable(res)) throw "";

			return parseUpdatedList(await res.text());
		})
	);

	if (versionFiles.some(versionFile => versionFile.formatVersion === -1)) return null; // Unknown format version or not ok status, so do a clean install

	let updated = new Set<string>();
	for (let i = 0; i < versionFiles.length; i++) {
		const versionFile = versionFiles[i];

		// If the installed version is the last of its file, its batch won't be iterated over in this containing loop
		const startIndex = installedInDownloadRange && i === 0? idInBatchOfOneAfterInstalled : 0;
		// ^ Ignore the files changed in versions before the installed

		for (let versionInFile = startIndex; versionInFile < versionFile.updated.length; versionInFile++) {
			versionFile.updated[versionInFile].forEach(href => updated.add(href));
		}
	}
	return updated;
}

const vwRequestModes = new Set<VWRequestMode>([
	"force-passthrough",
	"handle-only",
	"no-network"
	// "default" isn't needed
]);
function getVWRequestMode(request: Request, hasVirtualPrefix: boolean, searchParams: URLSearchParams): VWRequestMode {
	const headerValue = request.headers.get("vw-mode") as VWRequestMode | null; // Or also any other string
	if (vwRequestModes.has(headerValue as VWRequestMode)) return headerValue as VWRequestMode;
	const searchParamValue = searchParams.get("vw-mode");
	if (vwRequestModes.has(searchParamValue as VWRequestMode)) return searchParamValue as VWRequestMode; 

	return hasVirtualPrefix? "handle-only" : "default";
}
/**
 * @note This consumes `response`
 * @note This assumes the response is from the latest version
 */
function addVWHeaders(response: Response): Response {
	return modifyResponseHeaders(response, {
		"vw-version": VERSION.toString()
	});
}
/**
 * Removes the `Range` and `VW-Mode` headers, sets the method to `"GET"` and the cache mode to `"no-cache"`.
 */
function modifyRequestForCaching(request: Request, enforceGetRequest: boolean = true) {
	return modifyRequestHeaders(request, {
		range: null,
		"vw-mode": null
	}, {
		method: enforceGetRequest? "GET" : request.method,
		cache: "no-cache"
	});
}

const acceptableResponseTypes = new Set([
	"default",
	"basic"
]);
/**
 * Also adds the Versioned Worker headers
 */
async function fetchResource(
	pathWithoutBase: string, modifiedRequest: Request, isPage: boolean
): Promise<[response: Response, isError: boolean]> {
	let resource: Response;
	try {
		resource = await fetch(modifiedRequest);
	}
	catch {
		if (ROUTES.includes(pathWithoutBase) && isPage) {
			return [new Response("Something went wrong. Please connect to the internet and try again."), true];
		}
		else {
			return [Response.error(), true];
		}
	}

	if (acceptableResponseTypes.has(resource.type)) { // Other types are errors or redirects
		resource = addVWHeaders(resource);
	}
	return [resource, false];
}
/**
 * @note This consumes `resource`, if provided
 */
function updateResourceInBackground(
	modifiedRequest: Request, cache: Cache,
	fetchEvent: FetchEvent, resource?: Response
) {
	fetchEvent.waitUntil(
		(async () => {
			if (resource == null) resource = addVWHeaders(await fetch(modifiedRequest));
			
			if (isResponseUsable(resource)) {
				if (isResponseTheDefault(modifiedRequest, resource) && resource.status !== 206) { // Also checks that it's a GET request
					cache.put(modifiedRequest, resource); // Update it in the background
				}
			}
		})()
	);
}

function handleHeadRequest(response: Response, isHeadRequest: boolean): Response {
	if ((! isHeadRequest) || response.body == null) return response;

	response.body.cancel(); // This doesn't seem to be needed in Chrome or Firefox but it seems like a good idea to explicitly do this
	return new Response(null, {
		headers: response.headers
	});
}

function isResponseUsable(response: Response): boolean {
	if (! acceptableResponseTypes.has(response.type)) return false;
	const codeRange = Math.floor(response.status / 100);
	if (codeRange === 4 || codeRange === 5) return false;

	return true;
}

/**
 * Returns a built-in function if applicable, otherwise returns the user provided one
 */
function selectHandleFetchFunction(virtualHref: string | null, isCrossOrigin: boolean): Nullable<HandleFetchHook> {
	if (isCrossOrigin) return hooks.handleFetch;
	if (virtualHref === "quick-fetch" && true) return handleQuickFetch; // TODO: add config option to disable it

	return hooks.handleFetch;
}