# DynamicSpamScan

A website scanning tool that will crawl every page on your site and search for specific terms, but doesn't just check the server sent html, it loads the page in puppeteer and scans content after scrolling to the bottom of the page after the javascript has been run and inserted dynamic elements. This way it won't miss any spam content added by malware JavaScripts.

Dependencies: 
- Run `npm install` in your project directory.

Update items.txt
- Add one search term per line to this file, the script will search for each one.

Running the Script:
- Run `node scan.js https://your-domain.com/` to initiate a scan.

Output:
- The output will be saved as a .json and .html file for easy viewing and sharing.
- The console will update with each url scan result as well as it runs.
