// ===== Wishlist (Favorites) System =====

function getWishlist() {
  const saved = localStorage.getItem('loyaltymarket_wishlist');
  return saved ? JSON.parse(saved) : [];
}

function saveWishlist(list) {
  localStorage.setItem('loyaltymarket_wishlist', JSON.stringify(list));
}

function toggleWishlist(productId, heartButton) {
  let wishlist = getWishlist();

  if (wishlist.includes(productId)) {
    wishlist = wishlist.filter(id => id !== productId);
    heartButton.textContent = '♡';
    heartButton.classList.remove('active');
  } else {
    wishlist.push(productId);
    heartButton.textContent = '❤️';
    heartButton.classList.add('active');
  }

  saveWishlist(wishlist);
}

function initWishlistButtons() {
  const heartButtons = document.querySelectorAll('.heart');
  const wishlist = getWishlist();

  heartButtons.forEach((button, index) => {
    const card = button.closest('.product-card');
    if (!card) return;

    const titleEl = card.querySelector('h3');
    const productId = titleEl ? titleEl.textContent.trim() : 'product-' + index;

    button.setAttribute('data-product-id', productId);

    if (wishlist.includes(productId)) {
      button.textContent = '❤️';
      button.classList.add('active');
    }

    button.addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      toggleWishlist(productId, button);
    });
  });
}

document.addEventListener('DOMContentLoaded', initWishlistButtons);