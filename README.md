# Beam

Send files, text and links between your devices from the browser. One computer runs Beam; every other device just opens a web page. No apps, no accounts, no cables.

## Get it running

You need [Node.js](https://nodejs.org) 20 or newer. Nothing else gets installed.

```bash
git clone https://github.com/DhananjaySarathe/beam-file-transfer.git
```

```bash
cd beam-file-transfer
```

```bash
npm start
```

The terminal prints two addresses and a QR code:

- **This computer**: `http://localhost:3210`
- **Other devices**: something like `http://192.xxx.x.xx:3210`. Open it on any phone, tablet or laptop on the same Wi-Fi or network, or scan the QR code.

The first time, macOS or Windows may ask whether Node may accept incoming connections. Allow it, or other devices won't be able to reach the page. Press Ctrl+C in the terminal to stop Beam.

## Use it

1. Open Beam on two or more devices. Each one appears on the others with a name you can change (tap it, top right).
2. Tap a device, then choose files, drop them, paste them, or type some text or a link. On a computer you can also drop files straight onto a device.
3. The other device is asked to accept. Files go to its normal downloads; text shows up on the page with a Copy button.

Several files can go at once and they arrive one after another. If a download is interrupted, the receiver gets a Retry button. A transfer can be cancelled from either side.

## If another device can't open the page

- Both devices have to be on the same Wi-Fi or network. Guest networks often stop devices from talking to each other.
- Check that the firewall on the computer running Beam allows Node to accept incoming connections.
- A VPN on either device can hide it from the local network; pause it and try again.
- If port 3210 is taken, start Beam on another one: `PORT=4000 npm start` (in Windows Command Prompt, run `set PORT=4000` first, then `npm start`).

## How it works

- Each open page keeps an event stream to the server and is told which other pages are in the same room (the same network).
- Sending is an offer. Once it is accepted, the receiving browser requests each file as an ordinary download. The server holds that request, asks the sender's page to upload the file, and pipes the upload straight into the download.
- Nothing is written to disk on the computer running Beam, and only a few socket buffers sit in memory, so file size is limited by the devices themselves.
- If a device drops off for a moment (a phone locking its screen, a Wi-Fi blip), an accepted transfer waits for it and carries on when the same page reconnects. Closing or reloading a page ends its transfers.

## Good to know

- **Trusted networks only.** Beam speaks plain HTTP. Anyone on the same network can open the page, see the device names and send an offer (nothing is received without tapping Accept), and traffic is not encrypted. Use it at home or on a network you trust, and stop it when you are done.
- Beam collects nothing. There are no accounts, no analytics and no outside services; device names are random and stay in your browser.
- The sending page has to stay open until the transfer finishes. On phones, keep the screen on for large files.
- Folders can't be sent as they are; zip them first.
- A file may arrive a little smaller or larger than the size shown in the offer. Phones often hand a browser a photo that has been re-encoded or had its location data removed, so Beam goes by the bytes actually sent.
- The terminal prints a line for every offer, acceptance, interruption (with the reason) and completion, which is the first place to look if a transfer misbehaves.
- Checked end to end in Chrome on macOS. Safari, Firefox and mobile browsers use the same standard features but have not been confirmed yet.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3210` | Port to listen on. |
| `HOST` | all interfaces | Address to bind to. Use `127.0.0.1` to keep Beam to this computer. |
| `TRUST_PROXY` | off | Set to `1` when Beam runs behind a reverse proxy, so devices are grouped by the address in `X-Forwarded-For`. Without it, everyone reaching a proxied Beam lands in one room. |

On a private network every device shares one room. On a public server, devices behind the same public address share one.

## Tests

```bash
npm test
```

The tests start real server instances and drive them over HTTP the way two browsers would: discovery, multi-file transfers checked byte for byte, a 400 MB stream with a stalled receiver (to prove nothing is buffered), files whose real size differs from the offer, cancel, retry, reconnects, access checks and path safety.

## Layout

```
server.js            the whole server, no dependencies
public/index.html    page markup
public/app.js        page logic
public/styles.css    styles (light and dark)
public/vendor/       QR code generator (third party, see below)
test/                protocol tests
```

## Licence

Beam is released under the MIT licence; see [LICENSE](LICENSE).

It includes [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4 by Kazuhiko Arase, also MIT; its notice is in [public/vendor/qrcode-LICENSE.txt](public/vendor/qrcode-LICENSE.txt).
