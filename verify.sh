#!/bin/bash
# Verification script for blog.minte.dev

echo "🧪 Testing blog.minte.dev endpoints..."
echo ""

# Test homepage
echo "✓ Homepage:"
curl -s https://blog.minte.dev/ | grep -q "Building in Public" && echo "  ✅ Homepage loads" || echo "  ❌ Homepage failed"

# Test API
echo "✓ API endpoints:"
curl -s https://blog.minte.dev/api/posts | jq -e '.posts | length > 0' >/dev/null && echo "  ✅ /api/posts returns data" || echo "  ❌ API failed"

# Test individual post
echo "✓ Post page:"
curl -s https://blog.minte.dev/posts/welcome | grep -q "Welcome to Building in Public" && echo "  ✅ Post page renders" || echo "  ❌ Post page failed"

# Test tag filtering
echo "✓ Tag filtering:"
curl -s https://blog.minte.dev/tags/cloudflare | grep -q "Tag: cloudflare" && echo "  ✅ Tag filtering works" || echo "  ❌ Tag filtering failed"

# Test RSS feed
echo "✓ RSS feed:"
curl -s https://blog.minte.dev/rss.xml | grep -q "<?xml version" && echo "  ✅ RSS feed valid" || echo "  ❌ RSS feed failed"

# Test 404
echo "✓ 404 handling:"
curl -s https://blog.minte.dev/nonexistent | grep -q "404" && echo "  ✅ 404 page works" || echo "  ❌ 404 handling failed"

echo ""
echo "✅ All tests passed!"
