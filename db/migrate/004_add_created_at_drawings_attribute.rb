require 'server'

drawings = Drawing.all :per_page => 999999
puts "#{drawings.size} drawings found"

drawings.each do |drawing|
  puts "drawing id #{drawing[:id]}"
  drawing[:created_at] = drawing[:id].split('.').first
  puts "new drawing #{drawing.inspect}"
  
  REDIS.set(Drawing.key(drawing[:id]), drawing.to_json)
end