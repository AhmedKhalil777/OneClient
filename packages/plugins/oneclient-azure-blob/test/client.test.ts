import { describe, expect, it } from "vitest";
import { AUTH_ACCOUNT_KEY, AUTH_AZURITE, AUTH_SAS, buildService } from "../src/client.js";
import { guessContentType } from "../src/blobs.js";

describe("Azure Blob connection settings", () => {
  it("reads account name and key from a connection string (so SAS links can be signed)", () => {
    const h = buildService({ connectionString: "DefaultEndpointsProtocol=https;AccountName=myacct;AccountKey=a2V5;EndpointSuffix=core.windows.net" });
    expect(h.accountName).toBe("myacct");
    expect(h.credential).toBeDefined();
    expect(h.service.url).toBe("https://myacct.blob.core.windows.net/");
  });

  it("supports Azurite and account name + key", () => {
    expect(buildService({ authentication: AUTH_AZURITE }).service.url).toBe("http://127.0.0.1:10000/devstoreaccount1");
    expect(buildService({ connectionString: "UseDevelopmentStorage=true" }).accountName).toBe("devstoreaccount1");
    const h = buildService({ authentication: AUTH_ACCOUNT_KEY, accountName: "acct", accountKey: "a2V5" });
    expect(h.service.url.replace(/\/$/, "")).toBe("https://acct.blob.core.windows.net");
    expect(() => buildService({ authentication: AUTH_ACCOUNT_KEY, accountName: "acct" })).toThrow(/account name and one of its access keys/);
  });

  it("recognises account vs container SAS URLs, cloud and path-style", () => {
    const account = buildService({ authentication: AUTH_SAS, sasUrl: "https://acct.blob.core.windows.net/?sv=2022&sig=x" });
    expect(account.onlyContainer).toBeUndefined();
    expect(account.credential).toBeUndefined();
    expect(buildService({ authentication: AUTH_SAS, sasUrl: "https://acct.blob.core.windows.net/photos?sv=2022&sig=x" }).onlyContainer).toBe("photos");
    expect(buildService({ authentication: AUTH_SAS, sasUrl: "http://127.0.0.1:10000/devstoreaccount1/docs?sv=2022&sig=x" }).onlyContainer).toBe("docs");
    expect(() => buildService({ authentication: AUTH_SAS, sasUrl: "https://acct.blob.core.windows.net/photos" })).toThrow(/SAS URL/);
  });

  it("explains a missing connection string", () => {
    expect(() => buildService({})).toThrow(/connection string/);
  });

  it("guesses content types from file names", () => {
    expect(guessContentType("a/b/report.JSON")).toBe("application/json");
    expect(guessContentType("photo.jpeg")).toBe("image/jpeg");
    expect(guessContentType("unknown.bin")).toBe("application/octet-stream");
  });
});
