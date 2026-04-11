# App Icon Instructions

Before building the .exe installer, you need to add an icon.

## Requirements
- File name: `icon.ico`
- Location: `trade-tracker/electron/icon.ico`
- Format: Windows ICO file (must contain 256x256 and 32x32 sizes)

## How to create one
1. Design a 256x256 PNG (or use a free icon from iconscout.com, flaticon.com, etc.)
2. Convert to ICO using: https://convertico.com or https://icoconvert.com
3. Save as `icon.ico` in this folder

## If you don't add an icon
The BUILD-ELECTRON.bat script will automatically skip the icon and use the default Electron icon instead. The app will still build successfully.
