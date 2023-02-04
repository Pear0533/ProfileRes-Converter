@echo off
if not exist node_modules mkdir node_modules
if not exist node_modules\iconv-lite call npm install iconv-lite
if not exist node_modules\number-util call npm install number-util
if not exist node_modules\zlib call npm install zlib
node profileres.js "%~nx1"
pause