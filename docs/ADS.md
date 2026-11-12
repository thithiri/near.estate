# Building ads: first version

An ad is an image placed on a building's dedicated billboard. The owner's logo and building name remain on the storefront sign. The building illustration never contains the ad itself, so one approved image can be replaced without regenerating the facade.

The [phone-size owner form](images/near-estate-owner-ad-form-v1.png) shows the fill option and the crop preview before submission.

## What works now

- In the guest building picker, choose a two-unit **Diner** or **Arcade** at level 3 or 4, then choose **Try an ad image**. The PNG, JPEG or WebP is previewed locally on each eligible billboard and on the playable street after selecting the design. This preview is not uploaded or visible to other players.
- In the testnet owner screen, an owner of a billboard-capable plot chooses an ad image, sees its actual wide crop, optionally enters an HTTPS destination, and clicks **Submit ad for review**. **Fill billboard** is on by default: the browser prepares a centered PNG crop that fills the sign. The owner can turn it off to preserve the whole image with transparent space. The API accepts at most 1 MiB, normalizes the submitted file to a 512 × 256 transparent PNG, strips metadata and stores it by SHA-256 hash. The screen then prepares the exact proposal and sends it through the wallet. A moderator approves the image and building layout before the public street loads it from `/api/assets/:hash`.
- The renderer places an approved billboard image in the shared layout rectangle. The two-unit billboard now fills an 88 × 20 logical-pixel panel. The owner preview simulates the API's transparent 512 × 256 normalization followed by the street's centre crop; the moderator's composite uses the same centre crop. Standard version-1 storefront billboards use their 2:1 panel ratio. A custom version-1 facade may define a different rectangle, which the moderator checks in its actual facade preview. A missing or unapproved image leaves the building's blank sign visible.
- Selecting the building exposes an approved HTTPS link; merely seeing the ad does not open it. The client reports an estimated impression only after the loaded ad is fully visible for one continuous second. These counts do not pay coins.

## Image guidance

Use a wide banner with a simple mark and a few large words. Keep essential content near the center: the version-2 billboard is about 4.4:1. With **Fill billboard**, the crop becomes the uploaded image; for a narrow or portrait source, its outer edges will be removed. Turn it off to keep the full image and accept transparent side space after normalization. The owner preview shows the selected result before submission. Preview at 667 × 375 before submitting. Fine print will not be legible.

## Owner submission and recovery

The owner screen now presents **Choose image → Preview crop → Submit for review** as one guided action. Internally it saves the private upload and proposal before requesting the wallet action. If the proposal or wallet step is interrupted, the retained upload and proposal can be restored and the separate **Prepare proposal** or **Submit or check proposal** action can finish the same request. A new upload never becomes public directly.

For this first version, only two-unit Diner and Arcade designs at levels 3–4 have a reviewed billboard surface. One- and three-unit plots and the other designs still support logos on their storefront signs. More ad surfaces can be added as distinct, measured layout rectangles after their illustrated building art is reviewed.
