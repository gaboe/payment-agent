# payment-agent

A Bitcoin wallet the agent can operate on its own.

Today it speaks one protocol: Ark, via `barkd` (the daemon from Second) behind an
HTTPS endpoint, with a keeper loop that stops the funds from expiring. The name
is deliberately not `ark-agent` — Ark is the current backend, not the point. A
Lightning node, a Cashu wallet or Spark could sit behind the same interface
later, and the callers in `wallet.sh` should not have to care.

## The gateway

`barkd` has one bearer token and it can do everything — spend the entire
balance, offboard, start a unilateral exit. There is no scoping and no policy,
because it is a wallet daemon, not a payments API.

So `barkd` now binds to `127.0.0.1` and never faces the internet. A small Elysia
service on Bun sits in front of it, holds the daemon's token, and exposes only
what the agent needs:

| endpoint | scope | notes |
|---|---|---|
| `GET /ping` | — | health check |
| `GET /balance`, `/vtxos`, `/history`, `/limits` | read | |
| `POST /address`, `/invoice`, `/bip321` | invoice | |
| `POST /send` | spend | per-tx cap, daily cap, optional destination allowlist |
| `POST /refresh` | spend | |
| `GET /.well-known/lnurlp/agent` | — | Lightning address, public by necessity |

Scopes are hierarchical: a spend key can read. Keys are compared by hashing both
sides to 32 bytes first and then using `timingSafeEqual`, so neither the length
nor the content of a guess changes the comparison time — comparing the raw
strings would need a length check, and that check is itself an oracle.

Keys must be at least 20 characters and must differ from each other; both are
enforced at startup. Two equal values would silently promote the lower scope to
the higher one.

`/wallet/create`, `/offboard/all` and `/exit/start` are not proxied at all —
they exist in `barkd` but not in anything reachable from outside.

### Paying this wallet cheaply

Sending to `agent@pay.gaboe.xyz` from another client of the *same* Ark server
still costs the server's flat `lightning_send` minimum of 20 sat, because a
Lightning address can only ever produce a bolt11 and the payment leaves Ark and
comes back. On a 14 sat payment that is a 143% fee.

LNURL has no way to say "I also accept Ark". None of the 22 published LUDs
defines a field for an alternative rail; `payRequest` returns `pr` and nothing
else. The mechanism that does exist is BIP-321, a single URI carrying every
rail, and Noah parses it — `sendFlow.ts` has `getBip321Rails` over
`"ark" | "lightning" | "onchain"`.

So `./wallet.sh uri [sat]` returns one, and a sender that understands it takes
the Ark rail for free. Use the Lightning address for senders who have no Ark
wallet; use the URI for everyone else.

There is also an unwritten convention for exactly this, and Noah implements
both halves of it. Its client announces itself on the LNURL request:

```ts
arkLnurlEndpoint.searchParams.set("ark", arkInfoResult.value.server_pubkey);
```

and reads an `ark` address back out of the response:

```ts
if (acceptArkAddress && response.ark) {
  const validationResult = await validateArkoorPaymentAddress(response.ark);
  if (validationResult.isOk()) {
    return { method: "ark", destination: response.ark, ...limits };
  }
}
```

So `GET /.well-known/lnurlp/agent?ark=<server_pubkey>` answers with an `ark`
field when that pubkey matches this wallet's own server, and omits it otherwise
— to a caller on a different Ark server the address is unspendable, and Noah
would discard it anyway. The server pubkey is read from barkd at startup rather
than configured, so it cannot drift from the server the wallet is actually on.

The effect is that `agent@pay.gaboe.xyz` pays over Ark for free from an
Ark-native wallet, and over Lightning for everyone else, with no change on the
sender's side. This is not in any LUD; it is implemented from Noah's client
code.

It works in both directions. Noah's *server* answers the same handshake, so
paying `gabo@noahwallet.io` from here also takes the Ark rail:

```sh
curl "https://noahwallet.io/.well-known/lnurlp/gabo?ark=<server_pubkey>"
# → { "tag": "payRequest", "ark": "ark1pu6h30w3zqqppmyx…", … }
```

Both directions were settled for 0 sat. Over the Lightning rail the same
payments would each have cost the server's flat 20 sat minimum — on a 14 sat
payment, a 143% fee.

### The Lightning address

`agent@pay.gaboe.xyz` resolves, per LUD-16, to
`https://pay.gaboe.xyz/.well-known/lnurlp/agent`. It has to be unauthenticated —
someone paying you cannot hold a key — which is safe because receiving cannot
move funds out. The global rate limiter is what bounds invoice spam.

It carries a known deviation from LUD-06: the spec requires the invoice to have
`description_hash` (tag `h`) equal to sha256 of the metadata, and barkd cannot
set one. It accepts only a plain description, and its invoices carry tag `d`.
Wallets that verify the hash will reject them.

It ships anyway because the incumbent has the identical flaw. Decoding an
invoice from `gabo@noahwallet.io` — served by Noah's own barkd — gives:

```
tags: s(52), p(52), d(60), x(4), c(2), 9(4)
h (description_hash): absent
```

So this is no worse than the address it replaces, and it becomes correct for
free if barkd ever gains `description_hash`. Amounts arrive in millisatoshis and
anything below a whole satoshi is refused rather than rounded: quietly changing
what someone is paying is worse than making them retry.

Quota is **reserved before** the call to barkd and released if barkd refuses it.
Checking first and recording after would look equivalent and is not: the `await`
in between yields, so concurrent requests would all pass the check against a
stale tally and all spend. At 10k per transaction and 60 requests a minute that
is twelve times the daily cap in a minute, through the one control this whole
layer exists to provide.

A refused payment still gets its quota back, so invalid requests cannot burn the
daily limit. A request that fails *indeterminately* — a timeout, where the sats
may or may not have moved — keeps the reservation and returns 504: over-counting
a day's spend is recoverable, under-counting is not.

The tally lives in memory, so a restart resets it. That remains a real gap: a
process that crash-loops could exceed the daily cap. For a wallet holding a few
thousand sats a database is not worth it; if the balance grows, fix this first.

Every limit is parsed with `Number.isInteger` validation that throws at startup.
`Number(x) ?? default` guards only *unset*, never *malformed*: `SPEND_PER_TX_SAT=abc`
becomes NaN, every comparison against NaN is false, and the cap silently
disappears. The same typo in `MAINTAIN_INTERVAL` used to be worse — `setInterval`
clamps NaN to 1ms, turning the keeper into a millisecond loop against barkd and
Esplora.

### Rate limiting

Written here, not installed: `elysia-rate-limit` declares a peer dependency on
`elysia >= 2.0.0`, which is not a released version, and installing it against
Elysia 1.4 crashes at startup with `plugin.beforeHandle is undefined`. The
replacement is a fixed-window counter keyed on `X-Forwarded-For` — 40 lines,
with tests.

```sh
cd gateway && bun test
```

## Why a daemon and not the CLI

`bark` keeps its seed in a plaintext file and signs locally, so anything that can
run `bark` can also read the mnemonic. `barkd` puts an HTTP API in front of the
same wallet: the seed stays on the host, and callers get a bearer token instead.
`GET /api/v1/wallet/mnemonic` returns 404 unless the daemon is started with
`--expose-mnemonic`, which this deployment does not do.

That is a real boundary, but note what it is not: the token grants **full
spending access**. It is a wallet, not an allowance.

## Why the keeper loop

Ark VTXOs expire. When one does, the funds go to the Ark server — no theft, just
the contract ending. Refreshing is what keeps them alive, and the server charges
0 ppm to refresh a VTXO that is close to expiry (2000–5000 ppm if it still has
plenty of life, which prices pointless churn).

The phone wallet, Noah, solves this with silent push notifications that wake the
app, and this file used to say a server has no equivalent — which is why the
gateway runs a keeper. **That was wrong about barkd, and is corrected here.**
`barkd` 0.7.1 maintains itself: its daemon subscribes to the Ark server's round
events and calls `join_round_for_maintenance_refresh` on the first attempt of
each round, refreshing whatever sits under the expiry threshold. The setting
that would switch that subscription off, `daemon_manual_sync`, defaults to
`false`, and nothing here sets it. Rounds are started by the server on a timer
and broadcast to every subscriber, including a wallet doing nothing else.

So the keeper is a second mechanism, not the only one. It is kept because it is
observable from outside — `/health` publishes when maintenance last succeeded,
and barkd's own refresh publishes nothing — and because it refreshes on a
schedule this side controls. A new deployment does not need one: `barkpay` runs
the same barkd without a keeper, deliberately.

If the gateway dies the container exits, rather than leaving a wallet nobody is
refreshing.

It does **not** shell out to `bark maintain`. That was the first design and it
could never have worked:

```
$ docker exec <container> bark --datadir /data maintain
An error occurred: error opening wallet
Caused by:
	another process is already using datadir /data (holder PID: 147)
```

The CLI takes an exclusive lock on the datadir and `barkd` already holds it, so
every run would have failed — silently, six hours apart, until the VTXOs
expired. It went unnoticed for a while because the container kept restarting
before the first interval elapsed.

The keeper therefore works through barkd's HTTP API: sync, read the chain tip
from Esplora, list VTXOs, and refresh only those within
`REFRESH_THRESHOLD_BLOCKS` (144, matching bark's own mainnet default). It
deliberately does not call `POST /refresh/all`, which refreshes everything
regardless of expiry — the server charges 0 ppm near expiry and 2000-5000 ppm
otherwise, so refreshing indiscriminately is a standing fee for nothing.

The 6 hour interval is not arbitrary. `bark` refreshes a VTXO once it is within
`vtxo_refresh_expiry_threshold` of expiring — 144 blocks, about 24 hours, on
mainnet. So every VTXO gets four attempts inside its refresh window, which
matters because a refresh is not local: it joins an Ark round, and rounds run
hourly. A keeper that woke only once a day would get one shot at one round.

## A refresh waits on someone else's transaction

Refreshing joins an Ark round, and the round settles as one on-chain transaction
that the server funds and batches across every participant. A real one from this
wallet:

```
62f212cedc49cd26…   1 input, 2 outputs, 9,970,076 sat
fee 167 sat / 154 vB = 1.08 sat/vB
```

We paid nothing — 0 ppm applies under the expiry threshold — and the server paid
167 sat for everyone in the round. That is the whole economic argument for Ark.

The cost is a dependency that is easy to miss: **the server picks the fee rate,
and the refresh is not complete until that transaction confirms.** It cannot be
fee-bumped or replaced from here; it is not this wallet's transaction. At a
quiet mempool 1.08 sat/vB confirms quickly. At a busy one, a VTXO with only a
few blocks left could miss its window with nothing to be done about it.

Which is the real argument for the keeper's 24-hour threshold and 6-hour
interval: the refresh needs to start early enough that a slow block does not
matter.

## Expiry is inherited, not granted

Worth knowing before trusting a balance: an Ark transfer does **not** give the
receiver a fresh lifetime. In `ark-lib`, the off-chain send copies the sender's
value verbatim:

```rust
Vtxo { expiry_height: self.input.expiry_height, .. }
```

So a payment can arrive with hours left on it. `./wallet.sh vtxos` shows
`expiry_height`; compare it against the current block height, never assume the
28-day figure from `ark-info`.

## Layout

| file | what |
|---|---|
| `Dockerfile.build` | fetches upstream's `bark` + `barkd` 0.7.1 binaries, checksum-verified |
| `Dockerfile` | what Coolify deploys: a one-line pull of the CI-built image |
| `.github/workflows/build.yml` | builds and pushes `ghcr.io/gaboe/payment-agent` |
| `entrypoint.sh` | creates the wallet if absent, starts the keeper, runs `barkd` |
| `wallet.sh` | client for the payment API; token from the macOS Keychain |
| `deploy.sh` | tells Coolify to pull the new image, waits for `/ping` |

## Configuration

Set in Coolify, not in the image:

| variable | default | what |
|---|---|---|
| `ARK_SERVER` | `https://ark.second.tech` | Ark server |
| `ESPLORA` | `https://mempool.second.tech/api` | chain data |
| `MAINTAIN_INTERVAL` | `21600` | seconds between refresh runs |
| `BARKD_AUTH_SECRET` | *(none)* | 32-byte hex; fixes the bearer token. **Runtime only** — see below |
| `BARKD_EXPOSE_MNEMONIC` | unset | leave unset — enabling it serves the seed over HTTP |

`BARKD_AUTH_SECRET` is worth understanding. Without it barkd generates a random
token on first boot, which then has to be fished out of the container with
`docker exec`. With it, the token is decided before the container exists, so it
can be generated locally, kept in the Keychain and handed to Coolify as a secret
env var — no shell on the host needed to use the wallet.

It is not extra protection. Anyone who can read Coolify's environment can spend
the wallet, and so can anyone with `docker exec` on the host; this only removes
a step, it does not add a boundary.

Mark it runtime-only in Coolify. By default Coolify also hands variables to the
build as `ARG`s, which writes the value in plain text into the build log and,
when a build fails, into the `failed_jobs` table of Coolify's own database. A
secret that has ever been a build argument should be rotated, not re-used.

## The host is ARM

The deployment target is an `aarch64` Hetzner box. A single-platform amd64 image
fails at deploy time with `no match for platform in manifest: not found`, which
surfaces as a deployment that dies in seconds with no logs in the API. CI builds
`linux/amd64,linux/arm64` for that reason.

## First run

```sh
./wallet.sh balance
./wallet.sh address        # fund this over Ark; instant and free
```

## The token

There is only one credential to keep, the 32-byte hex in `BARKD_AUTH_SECRET`:

```sh
security add-generic-password -a "$USER" -s barkd-auth-secret -w
```

The bearer token the API expects is `base64url(0x00 || secret)` — urlsafe, so it
can contain `-` and `_`. `wallet.sh` derives it rather than storing a second
copy, which is why no step here ever needs a shell on the host.

(Worth a warning: a test secret of one repeated byte encodes identically under
both base64 alphabets, so it will not tell you which one is in use.)

Rotating means generating new hex, updating the Keychain and the Coolify
variable, and redeploying. It locks out anything holding the old token, which is
the only revocation mechanism that exists.

## Nothing here compiles

Upstream ships release binaries for both architectures with a `SHA256SUMS` file,
so the image just downloads and verifies them. Two earlier approaches were worse:

- **compiling on the VPS** — a Rust build of this size wants several GB of RAM,
  the 3.7 GB host had none to spare, and Coolify's own containers were starved
  until the panel went unreachable while the already-running sites kept serving.
- **cross-compiling in CI under QEMU** — safe for the server, but tens of minutes
  per build for an artifact upstream already publishes.

Using the release binaries also removes the `You're running a custom build of
bark, which might cause unexpected issues` warning that a cargo build carries,
and shortens the trust chain to upstream's own checksums.

## Coolify deployment notes

Things that cost time here and are not obvious from the panel:

**The proxy is Caddy, not Traefik.** Coolify 4.3 on this host runs
`lucaslorentz/caddy-docker-proxy`. Traefik labels attach to the container
happily and are then read by nobody, so a rule appears to be ignored rather than
rejected.

**`custom_labels` replaces Coolify's generated labels, it does not extend
them.** Setting only a new rule leaves the container with no `caddy_*` labels at
all; the site keeps working from the proxy's current config and breaks at the
next reload. Any custom label set has to restate the whole site block:

```
caddy_0=https://pay.gaboe.xyz
caddy_0.encode=zstd gzip
caddy_0.header=-Server
caddy_0.handle_path=/*
caddy_0.handle_path.0_reverse_proxy={{upstreams 3001}}
caddy_ingress_network=coolify
```

The port must match what the container actually exposes — the gateway on 3001,
not barkd. When handlers are ordered, numeric prefixes do it and the catch-all
comes last.

**A failed deployment logs nothing useful through the API.** `status` is
`failed`, `logs` is null, and `laravel.log` has no entry. The real error lives in
Coolify's own database:

```sql
SELECT exception FROM failed_jobs ORDER BY failed_at DESC LIMIT 1;
```

That is where `no match for platform in manifest` was hiding.

**Round participation survives a container restart.** It is persisted in the
wallet's sqlite, so redeploying while a refresh is mid-round does not lose it —
though the round itself may skip a wallet that vanishes mid-signing, so it waits
for the next one.

**Coolify deploys by starting the new container before stopping the old one.**
For anything stateful sharing a volume that is fatal:

```
Error: another barkd is already running on datadir /data (pid 11)
```

There is no "zero downtime" toggle in the API. Enabling
`is_consistent_container_name_enabled` fixes it: with a fixed container name
Docker refuses to run two, which forces stop-then-start. Anything else deployed
here that holds a lock — a database, another wallet — needs the same.

## Exposure

The API is on a public domain because that is how Coolify routes things and how
the client reaches it. What that means in practice, measured rather than assumed:

| | |
|---|---|
| `/ping` | 200, unauthenticated — Coolify's health check needs it |
| `/swagger-ui`, `/api-docs` | 403 at the proxy; `barkd` serves them unconditionally, the cargo feature is compiled into the release binary |
| everything else | 401 without a valid token, including every `POST` |

The token comparison uses `subtle::ConstantTimeEq`, so there is no timing
oracle, and the auth middleware is a `route_layer` — it runs before any request
body is parsed. Guessing 32 bytes is not a threat.

The real exposure is resource exhaustion: there is **no rate limiting**. Twelve
rapid attempts return twelve 401s with no backoff, and this Caddy build has no
`rate_limit` module (it is a plugin, and the proxy is shared with every other
site on the host).

So the mitigation is blast radius, not prevention. The container runs with:

```
limits_memory      512m     (steady-state use is ~12 MiB)
limits_memory_swap 512m
limits_cpus        0.5
```

Set these through Coolify's `limits_*` fields, not `custom_docker_run_options` —
the latter is stored but never reaches the container.

Flooding the endpoint can still waste CPU inside those bounds; it cannot take
the host down, which is what happened when an unbounded process did get loose
here. If the balance ever justifies closing the surface entirely, drop the domain
and reach the daemon through `ssh -L 3000:localhost:3000`.

## Knowing it still works

`restart=unless-stopped` means a crash-loop looks identical to a healthy wallet
from outside — the port answers, and nothing refreshes. So the question worth
asking is not "is the process up" but "did maintenance last succeed recently":

```sh
curl https://pay.gaboe.xyz/health
{"ok":true,"keeper_last_success":"2026-09-15T15:19:37.404Z","keeper_age_s":13,
 "keeper_interval_s":21600,"keeper_last_error":null}
```

It answers 503 once the last success is older than three keeper intervals — one
failure is a blip, three is a problem. It is unauthenticated on purpose: a
monitor that needs a key is one more thing that can quietly stop working. It
publishes liveness only, never balances.

`check-health.sh` polls it and raises a macOS notification when it goes stale or
unreachable. From cron, hourly:

```
0 * * * * /Users/gabrielecegi/op/payment-agent/check-health.sh
```

## Backups

The wallet's seed lives in `/data/mnemonic` inside the Coolify volume, on one
VPS, unencrypted. That was its only copy. A second copy is now in the operator's
macOS Keychain:

```sh
security find-generic-password -a "$USER" -s payment-agent-mnemonic -w
```

Recovering from it is `bark create --mnemonic`, which restores on-chain funds;
VTXOs are re-fetched from the Ark server's recovery mailbox on first sync.

`stop_grace_period` is 60s so a redeploy does not SIGKILL barkd mid-round — a
wallet that vanishes while a round is signing is skipped and waits for the next
one, which has already happened once here.

## Limits

The seed lives on the VPS. A host compromise is a wallet compromise, and there is
no second factor. Keep the balance at what you would not mind losing.

Unilateral exit — the property that makes Ark trust-minimised — has a floor. A
500 sat VTXO failed to produce a relayable exit chain:

```
Non-Standard VTXO: exit chain is not relayable:
dust sibling output at genesis item 16/18, output 0
```

Eighteen transactions deep, with a dust output no node will relay. Below some
amount you are effectively in custody with the Ark server, able to spend only
while it cooperates. Check `bark exit estimate-fee` for real numbers before
treating a balance as exitable.
