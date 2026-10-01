tutorial video

https://www.youtube.com/watch?v=VwXxAR9tCDY

First of all we need to create a self signed certificate for code signing, the publisher name should be the one that is used in appx publisher name with CN=

```bash
pnpx electron-builder create-self-signed-cert -p "ADBBA92C-68FC-4614-8695-A08D2C192895"
```

The `.pfx` stays in this folder on your machine only: git ignores it, and it must never be committed or uploaded (CI included). Anyone holding it can sign packages as this publisher.

Now we can just copy paste the compiled appx from dist into code-signing folder and rename it to package and run the following command in Developer Command Prompt for VS 2022

```bash
SignTool sign /debug /fd SHA256 /a /f ADBBA92C-68FC-4614-8695-A08D2C192895.pfx package.appx
```

Next we need to install the certificate in the Trusted Root Certification Authorities store.

1. local machine
2. Do NOT let Windows automatically select the store. Choose **Place all certificates in the following store**, click Browse, and explicitly select **Trusted People**.
