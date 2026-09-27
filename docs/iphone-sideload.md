# Carrier on an iPhone, from Linux, for free

No Mac and no paid Apple account needed. GitHub builds the app on one of its
Macs, and you install it on your phone from Linux with your ordinary Apple ID.
Apple's rules for free accounts apply: the app works for **7 days** and then
has to be reinstalled (your key and slips stay on the phone in between), and
you can have **3** sideloaded apps at a time.

## 1. Get the .ipa

1. Open the repository's **Actions** tab on GitHub, pick **iPhone build
   (unsigned, for sideloading)** and press **Run workflow** (on `main`).
2. When the run turns green (about 20 to 30 minutes), open it and download
   **Carrier-unsigned-ipa** at the bottom. It's a zip with `Carrier.ipa` inside.

The build is unsigned on purpose: the installer below signs it with your own
Apple ID.

## 2. Install it with iloader (Arch)

[iloader](https://github.com/nab138/iloader) is an open-source installer that
does what Xcode does when it puts an app on your own phone. Download it only
from its GitHub page or iloader.app; on Arch there's an unofficial AUR package.

```bash
sudo pacman -S usbmuxd      # talks to the iPhone over USB
yay -Ss iloader             # the AUR package; or use the AppImage from GitHub
```

1. Plug the iPhone in with a cable and tap **Trust** on the phone.
2. Open iloader and sign in with your Apple ID (it asks for the two-factor code).
   A spare Apple ID works too, if you'd rather not use your main one.
3. Choose **Import IPA** and pick `Carrier.ipa`.
4. On the phone: **Settings › Privacy & Security › Developer Mode**, turn it on
   and restart when asked. Then **Settings › General › VPN & Device
   Management**, tap your Apple ID and **Trust** it.
5. Open Carrier. The first time the radio starts, iOS asks for **Local
   Network** and **Bluetooth**. Allow both, or no one will show up.

After 7 days, run step 2 again with the same `.ipa` (or a newer one).

Other Linux installers if iloader gives you trouble:
[Impactor](https://github.com/khcrysalis/PlumeImpactor) and
[AltServer-Linux](https://github.com/NyaMisty/AltServer-Linux).

## What to expect

- iPhones pass payments to iPhones over the radio. An iPhone and an Android
  can't hear each other's radio; hand over by QR code between them.
- Nothing in this build has run on a real iPhone before your install. If
  something breaks, the thread wants to know what you saw.
