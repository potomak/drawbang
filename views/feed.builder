builder do |xml|
  xml.instruct! :xml, :version => '1.0'
  xml.rss :version => "2.0", 'xmlns:atom' => "http://www.w3.org/2005/Atom" do
    xml.channel do
      xml.title "Draw!"
      xml.description "Drawings from Draw!"
      xml.link "http://#{request.host_with_port}/feed.rss"
      xml.atom :link, :href => "http://#{request.host_with_port}/feed.rss", :rel => "self", :type => "application/rss+xml"

      @drawings.each do |drawing|
        xml.item do
          xml.title drawing[:id]
          xml.link drawing[:share_url]
          xml.description do
            xml.cdata!("<img src='#{drawing['url']}'/> #{"<br/>by <img src='#{drawing['user']['image']}' width='25'/> #{drawing['user']['first_name']}" if drawing['user']}")
          end
          xml.pubDate Time.at(drawing[:id].gsub(/\.png/, '').to_i).rfc822
          xml.guid drawing[:share_url]
        end
      end
    end
  end
end