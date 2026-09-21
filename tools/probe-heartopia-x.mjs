const targets = [
  "https://syndication.twitter.com/srv/timeline-profile/screen-name/MyHeartopia",
  "https://syndication.twitter.com/srv/timeline-profile/screen-name/Heartopia_JP",
  "https://x.com/myheartopia",
  "https://x.com/Heartopia_JP"
];

for (const url of targets) {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/136 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml"
      }
    });
    const text = await response.text();
    const statusLinks = [...text.matchAll(/https?:\\\/\\\/(?:x|twitter)\\.com\\\/[A-Za-z0-9_]+\\\/status\\\/[0-9]+/g)].map(m => m[0]);
    console.log(JSON.stringify({
      url,
      status: response.status,
      finalUrl: response.url,
      bytes: text.length,
      hasGiftCode: /Gift\\s*Code|ギフトコード/i.test(text),
      statusLinks: [...new Set(statusLinks)].slice(0, 5)
    }));
  } catch (error) {
    console.log(JSON.stringify({ url, error: error instanceof Error ? error.message : String(error) }));
  }
}

// PR probe sync marker
