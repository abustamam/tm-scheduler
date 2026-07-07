/** Options page (#107): one-time token + server-URL setup, saved to storage. */
const DEFAULT_SERVER = import.meta.env.WXT_GAVELUP_URL ?? "https://gavelup.app";
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

async function load() {
	const s = await browser.storage.local.get(["token", "serverUrl"]);
	$("token").value = (s.token as string) || "";
	$("server").value = (s.serverUrl as string) || DEFAULT_SERVER;
}

document.getElementById("save")?.addEventListener("click", async () => {
	await browser.storage.local.set({
		token: $("token").value.trim(),
		serverUrl: $("server").value.trim() || DEFAULT_SERVER,
	});
	const saved = document.getElementById("saved") as HTMLSpanElement;
	saved.hidden = false;
	setTimeout(() => {
		saved.hidden = true;
	}, 1500);
});

load();
