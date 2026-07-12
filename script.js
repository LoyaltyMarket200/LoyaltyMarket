// ===== Wishlist (Favorites) System =====

function getWishlist() {
  const saved = localStorage.getItem("loyaltymarket_wishlist");

  try {
    return saved ? JSON.parse(saved) : [];
  } catch (error) {
    console.error("Could not read wishlist:", error);
    return [];
  }
}

function saveWishlist(list) {
  localStorage.setItem(
    "loyaltymarket_wishlist",
    JSON.stringify(list)
  );
}

function toggleWishlist(productId, heartButton) {
  let wishlist = getWishlist();

  if (wishlist.includes(productId)) {
    wishlist = wishlist.filter(
      (id) => id !== productId
    );

    heartButton.textContent = "♡";
    heartButton.classList.remove("active");
  } else {
    wishlist.push(productId);

    heartButton.textContent = "❤️";
    heartButton.classList.add("active");
  }

  saveWishlist(wishlist);
}

function initWishlistButtons() {
  const heartButtons =
    document.querySelectorAll(".heart");

  const wishlist = getWishlist();

  heartButtons.forEach((button, index) => {
    const card = button.closest(".product-card");

    if (!card) {
      return;
    }

    const productId =
      button.dataset.productId ||
      card.querySelector("h3")?.textContent.trim() ||
      "product-" + index;

    button.dataset.productId = productId;

    if (wishlist.includes(productId)) {
      button.textContent = "❤️";
      button.classList.add("active");
    } else {
      button.textContent = "♡";
      button.classList.remove("active");
    }

    if (
      button.dataset.wishlistReady === "true"
    ) {
      return;
    }

    button.dataset.wishlistReady = "true";

    button.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        event.stopPropagation();

        toggleWishlist(
          productId,
          button
        );
      }
    );
  });
}

window.initWishlistButtons =
  initWishlistButtons;

document.addEventListener(
  "DOMContentLoaded",
  initWishlistButtons
);