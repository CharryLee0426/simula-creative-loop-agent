"""Download the Noto Serif CJK SC Bold font used for all on-screen text (covers Latin and Chinese)."""
import os, sys, urllib.request
HERE = os.path.dirname(os.path.abspath(__file__))
DST = os.path.join(HERE, "assets", "fonts", "NotoSerifCJKsc-Bold.otf")
URL = "https://github.com/notofonts/noto-cjk/raw/main/Serif/OTF/SimplifiedChinese/NotoSerifCJKsc-Bold.otf"
if os.path.exists(DST) and os.path.getsize(DST) > 1_000_000:
    print("font ok:", DST); sys.exit(0)
os.makedirs(os.path.dirname(DST), exist_ok=True)
print("downloading", URL)
urllib.request.urlretrieve(URL, DST + ".part")
os.replace(DST + ".part", DST)
print("font ok:", DST)
