require 'server'

drawings = Drawing.all :per_page => 999999
puts "#{drawings.size} drawings found"

drawings.each do |drawing|
  puts "drawing id #{drawing[:id]}"
  
  if drawing['user'] && drawing['user']['uid']
    puts "push drawing to #{Drawing.list(drawing['user']['uid'])}"
    REDIS.rpush(Drawing.list(drawing['user']['uid']), drawing['id'])
  end
end