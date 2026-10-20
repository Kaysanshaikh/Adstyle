"""Turns your two Apps Script pages into the Vercel pages.
Put Kiosk.html and Admin.html next to this file, then run:  python prepare.py
It writes public/index.html (kiosk) and public/admin.html (admin)."""
import sys

def patch(src, dst, head, swaps=()):
    try:
        html = open(src, encoding='utf-8').read()
    except FileNotFoundError:
        sys.exit('Missing ' + src + ' - copy it from your Apps Script project into this folder.')
    if '</head>' not in html:
        sys.exit(src + ': no </head> found')
    html = html.replace('</head>', head + '\n</head>', 1)
    for a, b in swaps:
        html = html.replace(a, b)
    open(dst, 'w', encoding='utf-8').write(html)
    print('wrote', dst)

shim = '<script src="shim.js"></script>'
patch('Kiosk.html', 'public/index.html', shim + '\n'
      '<script>if(location.search.indexOf("page=admin")>-1) location.replace("/admin");</script>\n'
      '<meta name="theme-color" content="#1763B8">\n'
      '<link rel="manifest" href="manifest.json">\n'
      '<link rel="apple-touch-icon" href="icon-192.png">\n'
      "<script>if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');</script>")
patch('Admin.html', 'public/admin.html', shim,
      [('OPEN GOOGLE SHEET', 'DOWNLOAD BACKUP'),
       ('The photos already in Google Drive are not touched', 'The photos already in storage are not touched')])
