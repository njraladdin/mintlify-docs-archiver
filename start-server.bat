@echo off
echo Starting local server for viewing the archived website...
echo.
echo This will install http-server package temporarily if it's not already installed.
echo.

:: Run the server using npx
npx http-server output -p 8095

:: If there's an error, pause to show the message
if %ERRORLEVEL% neq 0 (
    echo.
    echo Error: Could not start the server. Make sure Node.js is installed.
    pause
    exit /b 1
)

:: The script should remain open as long as the server is running 