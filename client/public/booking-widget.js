(function() {
  'use strict';
  
  var WIDGET_VERSION = '1.0.0';
  
  function getScriptOrigin() {
    try {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        var src = scripts[i].src;
        if (src && src.indexOf('booking-widget.js') !== -1) {
          return new URL(src).origin;
        }
      }
    } catch (e) {
      console.warn('[BookingWidget] Could not determine script origin, falling back to window.location.origin:', e);
    }
    return window.location.origin;
  }
  
  function BookingWidget(config) {
    this.slug = config.slug;
    this.container = config.container || 'booking-widget';
    this.width = config.width || '100%';
    this.height = config.height || '700px';
    this.baseUrl = config.baseUrl || getScriptOrigin();
    
    this.init();
  }
  
  BookingWidget.prototype.init = function() {
    var container = document.getElementById(this.container);
    if (!container) {
      console.error('[BookingWidget] Container element not found:', this.container);
      return;
    }
    
    var iframe = document.createElement('iframe');
    iframe.src = this.baseUrl + '/book/' + encodeURIComponent(this.slug) + '?embed=true';
    iframe.style.width = this.width;
    iframe.style.height = this.height;
    iframe.style.border = 'none';
    iframe.style.borderRadius = '8px';
    iframe.style.overflow = 'hidden';
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('scrolling', 'auto');
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('title', 'Schedule an Appointment');
    
    container.appendChild(iframe);
    
    this.iframe = iframe;
  };
  
  BookingWidget.prototype.destroy = function() {
    if (this.iframe && this.iframe.parentNode) {
      this.iframe.parentNode.removeChild(this.iframe);
    }
  };
  
  window.BookingWidget = BookingWidget;
  
  if (window.BookingWidgetConfig) {
    new BookingWidget(window.BookingWidgetConfig);
  }
})();
