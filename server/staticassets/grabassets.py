# This script downloads all staticassets from the rec.zone server and saves them to the local staticassets directory.
# Per reqeust of RecZone management, we cannot include RecZone assets in the public repo, so this script is provided to allow developers to download the assets themselves.
import os
import requests

BASE_URL = "https://rec.zone"
DEST_DIR = "./staticassets"

paths = [
    "/uploads/music/mwe48ois-nblkq5.mp3",
    "/uploads/music/mwe48r1l-4hipj7.mp3",
    "/uploads/music/mwe48uer-e80n96.mp3",
    "/uploads/music/mwe48z14-jbehc9.mp3",
    "/uploads/music/mwe493hz-y0xmav.mp3",
    "/uploads/music/mwe499xa-ahz6z9.mp3",
    "/uploads/music/mwe49eca-ey6cy0.mp3",
    "/uploads/music/mwe49j0b-lq9s07.mp3",
    "/uploads/music/mwe49o5s-v0x9wc.mp3",
    "/uploads/music/mwe49ti8-mfb3v2.mp3",
    "/uploads/music/mwe49x52-ipn2qa.mp3",
    "/uploads/music/mwe9018t-1jx20u.mp3",
    "/uploads/music/mwe90f4m-gr44tw.mp3",
    "/uploads/music/mwe90nhh-dvg8w4.mp3",
    "/uploads/music/mwe9fyg6-ks6bcr.mp3",
    "/uploads/music/mwe9g42c-ipqvqb.mp3",
    "/uploads/music/mwe9h3rs-iyjeau.mp3",
    "/uploads/music/mwe9uu6d-62aotz.mp3",
    "/uploads/music/mwebsid9-qbzvtu.mp3",
    "/uploads/music/mwebsov0-0fldeb.mp3",
    "/uploads/music/mwebssba-1jg0u5.mp3",
    "/uploads/music/mwebt6ra-8edxwo.mp3",
    "/uploads/music/mwebtakd-pmk9bn.mp3",
    "/uploads/music/mwecapp6-ntnjsq.mp3",
    "/uploads/music/mwecb7xd-l7inw3.mp3",
    "/uploads/music/mwecbd8f-ad98gd.mp3",
    "/uploads/music/mwe3k7ud-dwzuwm.wav",
]

for path in paths:
    save_path = os.path.join(DEST_DIR, path.lstrip("/"))
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    
    response = requests.get(BASE_URL + path)
    with open(save_path, "wb") as f:
        f.write(response.content)
