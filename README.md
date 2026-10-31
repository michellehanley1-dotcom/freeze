# Freeze

The memory card game. Get your hand to 4 or less. Each person plays on their own phone; send the room link in iMessage.

## Try it right now (demo mode)
Open `index.html` through any local web server (for example `python3 -m http.server` in this folder), then open the page in 2 or 3 browser tabs. Each tab is a different player.

## Put it online (free, about 15 minutes)

**1. Firebase (keeps everyone's game in sync)**
1. Go to console.firebase.google.com, add a project called `freeze` (Analytics off is fine).
2. Build > **Authentication** > Get started > **Anonymous** > Enable.
3. Build > **Realtime Database** > Create database > any US location > start in **locked mode**.
4. In the database's **Rules** tab, paste the contents of `database.rules.json` and Publish.
5. Project settings (gear) > Your apps > **Web** (`</>`) > register an app called Freeze. Copy the config values into `firebase-config.js`. Make sure `databaseURL` is filled in (it's shown at the top of the Realtime Database page).

**2. GitHub Pages (hosts the app)**
1. Create a GitHub repository (for example `freeze`) and upload every file in this folder.
2. Repository Settings > **Pages** > Source: Deploy from a branch > `main` / root > Save.
3. After a minute your game is live at `https://<your-username>.github.io/freeze/`.

**3. Play**
Open the link on your iPhone, tap Share > **Add to Home Screen** so it opens like an app. Start a game, tap **Invite via iMessage**, and friends join from the link.

## Files
- `game.js`: all the rules (pure functions, easy to tweak)
- `app.js`: screens and syncing
- `styles.css`: the look
- `firebase-config.js`: your Firebase keys
- `database.rules.json`: database security rules

Note: it's built for friends. A determined player could peek at hidden cards with browser developer tools.
